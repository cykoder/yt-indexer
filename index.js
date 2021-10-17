import { MongoClient } from 'mongodb';
import Crawler from 'crawler';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import xmlParser from 'fast-xml-parser';
import { SingleBar } from 'cli-progress';
import { URL } from 'url';
import searchYoutube from './innertube.js';

// Load config from .env
dotenv.config({ path: './.env' });

// Load words list for random searches
const wordsList = fs.readFileSync('./words.txt', {encoding: 'utf8', flag: 'r'}).split('\n');
const wordsListCount = wordsList.length;

let urlCounter = 0; // Used to show progress in CLI
const urlCountMax = 20000; // Max urls to store until cache reset

// Random timeout for searches to spread requests across instances
const randomSearchTimeout = Math.floor(1000 + Math.random() * 2000);

// Create a new progress bar instance
const bar1 = new SingleBar({}, {
  format: ' {bar} {percentage}% | {value}/{total}',
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591'
});

// Connection URL
const url = process.env.MONGODB_URI;
const client = new MongoClient(url);

// Database Name
const dbName = 'yt-indexer';
const crawledURIs = []; // In memory cache of crawled URIs

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
  // We use oembed here so that random video check requests dont effect our API rate limits if used
  const videoUri = `https://www.youtube.com/watch?v=${id || randomVideoId()}`;
  const url = `https://www.youtube.com/oembed?url=${videoUri}&format=json`;
  if (id) { // If ID is provided double check that its not in the database
    const docCount = await videosCollection.count({ uri: videoUri });
    if (docCount === 0) {
      crawlURI(crawler, url, 1);
    }
  } else {
    crawlURI(crawler, url);
  }

  if (!id) {
    setTimeout(() => {
      crawlYTVideo(crawler, videosCollection);
    }, 50);
  }
}

async function crawlRandomSearch(crawler, videosCollection) {
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

  setTimeout(() => {
    crawlRandomSearch(crawler, videosCollection);
  }, randomSearchTimeout);
}

// Callback for when a page has been crawled
// typically would be omebed JSON or RSS feed
async function onCrawled(error, res, done, opts) {
  urlCounter++;
  if (urlCounter >= urlCountMax) {
    urlCounter = 0;
    crawledURIs = [];
  }
  bar1.update(urlCounter);

  try {
    const { uri } = res.options;
    const videoUri = uri.replace('https://www.youtube.com/oembed?url=', '');
    if (error) {
      console.error(error);
      return;
    }

    if (res.statusCode === 401 || res.body === 'Unauthorized') {
      // Unauthorized means that the video exists but is flagged as not embeddable
      // only way to get info would be through the youtube API - which we can do later
      // so for now lets just store it in the database as a valid uri
      try {
        console.log('\nCrawled unauthed URI:', uri)
        await videosCollection.insertOne({
          uri: videoUri,
        });
      } catch (e) {
        // Assume dupe key
      }
    } else if (res.statusCode === 200) {
      const { title, author_name, author_url, thumbnail_url } = JSON.parse(res.body);
      const { crawler, videosCollection } = opts;
      console.log('\nIndexed URI:', videoUri)

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
    }
  } catch (e) {
    console.error(e);
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

  // Do some crawling
  console.log('Starting crawling...');
  if (!process.env.DISABLE_SEARCH) {
    crawlRandomSearch(crawler, videosCollection);
  }
  crawlYTVideo(crawler, videosCollection);

  // Start the progress bar with a total value of 100 and start value of 0
  bar1.start(urlCountMax, 0, {
    speed: 'N/A'
  });
}

main();
