import { MongoClient } from 'mongodb';
import Crawler from 'crawler';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import xmlParser from 'fast-xml-parser';
import Fastify from 'fastify';
import { URL } from 'url';
import searchYoutube from './innertube.js';

// Load config from .env
dotenv.config({ path: './.env' });

// Load words list for random searches
const wordsList = fs.readFileSync('./words.txt', {encoding: 'utf8', flag: 'r'}).split('\n');
const wordsListCount = wordsList.length;

// Random timeout for searches to spread requests across instances
const randomSearchTimeout = Math.floor(2000 + Math.random() * 2000);

// Connection URL
const url = process.env.MONGODB_URI;
const client = new MongoClient(url);

const dbName = 'yt-indexer'; // Database Name
const urlCountMax = 50000; // Max urls to store until cache reset

let crawledURIs = []; // In memory cache of crawled URIs
let skipAddingNew = false;
let failedCounter = 0;
let urlCounter = 0;

// Start web server for reporting
const fastify = Fastify({
  logger: false
});

// Generates a psuedo-random b64 char
const baseAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function randomChar() {
  return baseAlphabet[crypto.randomInt(0, 64)];
}

// Generates a psuedo-random video ID
function randomVideoId() {
  const vidId = [
    randomChar(), randomChar(), randomChar(), randomChar(),
    randomChar(), randomChar(), randomChar(), randomChar(),
    randomChar(), randomChar(), randomChar(),
  ];
  return vidId.join('');
}

// Puts a uri into crawl que and cache
function crawlURI(crawler, uri, priority = 5) {
  if (crawledURIs.indexOf(uri) === -1) {
    crawledURIs.push(uri);
    crawler.queue(uri, { priority });
  }
}

// Takes a video ID (or generates a random one) and creates an oembed URI that we can use
// to gather public metadata of the video. Then it will insert the URI into the crawler que
async function crawlYTVideo(crawler, videosCollection, id) {
  // If queue is already processing quite a few requests then dont generate
  // random videos URIs. Set a timeout to check again later
  if (!id && (skipAddingNew || crawler.queueSize > 64)) {
    console.log('Queue size too large, skipping random video ID generation');
    setTimeout(() => {
      crawlYTVideo(crawler, videosCollection);
    }, 5000);
    return;
  }

  // We use oembed here so that random video check requests dont effect our API rate limits if used
  const videoUri = `https://www.youtube.com/watch?v=${id || randomVideoId()}`;
  const url = `https://www.youtube.com/oembed?url=${videoUri}&format=json`;
  if (id) { // If ID is provided double check that its not in the database
    const docCount = await videosCollection.count({ uri: videoUri });
    if (docCount === 0) {
      crawlURI(crawler, url, 1);
    }
  } else {
    // Insert with random priority so that we can still process
    // some random URIs even if random search is producing alot of results
    crawlURI(crawler, url, crypto.randomInt(1, 3));
  }

  if (!id) {
    setTimeout(() => {
      crawlYTVideo(crawler, videosCollection);
    }, 50);
  }
}

// Gets a random word from the dictionary and searches it with the
// innertube API. It will add the video uris to the crawler que at high priority
async function crawlRandomSearch(crawler, videosCollection) {
  // Set skip adding new if que is too large until its nearly all been processed
  if (!skipAddingNew && crawler.queueSize > 128) {
    skipAddingNew = true;
  } else if (skipAddingNew && crawler.queueSize <= 4) {
    skipAddingNew = false;
  }

  // If que is growing too fast, dont perform more random searches
  if (!skipAddingNew) {
    const randomQueryString = wordsList[crypto.randomInt(0, wordsListCount)];
    console.log('Searching for:', randomQueryString);

    // Get a list of video IDs from this mess of an API result
    try {
      const videoList = await searchYoutube(randomQueryString);
      for (let i = 0; i < videoList.length; i++) {
        const videoId = videoList[i];
        if (videoId) {
          crawlYTVideo(crawler, videosCollection, videoId);
        }
      }
      console.log('Added', videoList.length, 'random videos');
    } catch (e) {
      console.error('Unable to crawl random search:', e.message)
    }
  } else {
    console.log('Queue size too large, skipping random video search');
  }

  setTimeout(() => {
    crawlRandomSearch(crawler, videosCollection);
  }, randomSearchTimeout);
}


// Callback for when a page has been crawled
// typically would be omebed JSON or RSS feed
async function onCrawled(error, res, done, opts) {
  try {
    const { uri } = res.options;
    const { crawler, videosCollection } = opts;
    const videoUri = uri.replace('https://www.youtube.com/oembed?url=', '');
    if (error || res.statusCode === 500) {
      failedCounter++;
      console.error(error || `Server error: ${res.statusCode} ${res.body} ${uri}`);
      return;
    }

    if (res.statusCode === 401 || res.body === 'Unauthorized') {
      // Unauthorized means that the video exists but is flagged as not embeddable
      // only way to get info would be through the youtube API - which we can do later
      // so for now lets just store it in the database as a valid uri
      try {
        console.log('\nCrawled unauthed URI:', uri)
        await videosCollection.updateOne({ uri: videoUri }, {
          $set: {
            uri: videoUri,
          },
        }, { upsert: true });
      } catch (e) {
        console.error(e);
      }
    } else if (res.statusCode === 200) {
      const { title, author_name, author_url, thumbnail_url } = JSON.parse(res.body);
      // console.log('\nIndexed URI:', videoUri);

      try {
        await videosCollection.updateOne({ uri: videoUri }, {
          $set: {
            uri: videoUri,
            title,
            authorName: author_name,
            authorUrl: author_url,
            thumbnail: thumbnail_url,
          },
        }, { upsert: true });
      } catch (e) {
        console.error(e);
      }

      // Get RSS feed of channel and crawl their videos
      const ytChannelStr = 'https://www.youtube.com/channel/';
      if (author_url.substr(0, ytChannelStr.length) === ytChannelStr) {
        const channelId = author_url.substr(ytChannelStr.length);
        const rssUri = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        if (crawledURIs.indexOf(rssUri) === -1) {
          crawledURIs.push(rssUri);
          axios.get(rssUri)
            .then(feedResponse => {
              const { feed } = xmlParser.parse(feedResponse.data, {});
              for (let i = 0; i < feed.entry.length; i++) {
                const feedItem = feed.entry[i];
                if (feedItem && feedItem['yt:videoId']) {
                  crawlYTVideo(crawler, videosCollection, feedItem['yt:videoId']);
                }
              }
            });
        }
      }

      urlCounter++;
      if (urlCounter >= urlCountMax) {
        urlCounter = 0;
        crawledURIs = [];
      }
    } else {
      failedCounter++;
    }
  } catch (e) {
    console.error(e);
    failedCounter++;
  }
  done();
}

async function main() {
  // Connect to MongoDB
  await client.connect();
  console.log('Connected successfully to database');

  // Select database and videos collection
  const db = client.db(dbName);
  const videosCollection = db.collection('videos');

  // Ensure DB indices exist
  await videosCollection.createIndex({ uri: 1 }, { unique: true });
  await videosCollection.createIndex({ description: 1 });
  await videosCollection.createIndex({ title: 1 });
  await videosCollection.createIndex({ authorUrl: 1 });
  await videosCollection.createIndex({ authorName: 1 });

  // Crawler object def
  const crawler = new Crawler({
    maxConnections: process.env.MAX_CONNECTIONS || 8,
    rateLimit: process.env.RATE_LIMIT || 50,
    timeout: 5000,
    callback: (error, res, done) => {
      return onCrawled(error, res, done, {
        videosCollection,
        crawler,
      });
    },
    retries: 0,
    jQuery: false,
  });

  // Base stats rout
  fastify.get('/', (request, reply) => {
    reply.send({
      total: crawledURIs.length,
      queueSize: crawler.queueSize,
      indexedCount: urlCounter,
      failed: failedCounter,
    });
  });

  // Run the server!
  const serverPort = parseInt(process.env.PORT || 8080, 10) + parseInt(process.env.NODE_APP_INSTANCE || 0, 10);
  fastify.listen(serverPort, process.env.BIND_IP || '0.0.0.0', (err, address) => {
    if (err) {
      throw err;
    }

    console.log(`Server is now listening on ${address}`);
  });

  // Do some crawling
  console.log('Starting crawling...');
  if (!process.env.DISABLE_SEARCH) {
    crawlRandomSearch(crawler, videosCollection);
  }
  crawlYTVideo(crawler, videosCollection);
}

main();
