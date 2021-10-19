import { MongoClient } from 'mongodb';
import Crawler from 'crawler';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import xmlParser from 'fast-xml-parser';
import Fastify from 'fastify';
import qs from 'qs';
import cheerio from 'cheerio';
import { URL } from 'url';
import searchYoutube from './innertube.js';

// Load config from .env
dotenv.config({ path: './.env' });

// Numerical ID of this instance in cluster mode or 0 otherwise
const clusterInstanceId = parseInt(process.env.NODE_APP_INSTANCE || 0, 10);

// Load words list for random searches
const wordsList = fs.readFileSync('./words.txt', {encoding: 'utf8', flag: 'r'}).split('\n');
const wordsListCount = wordsList.length;

// Random timeout for searches to spread requests across instances
const youtubeSearchTimeout = Math.floor(2000 + Math.random() * 1000 + clusterInstanceId * 1000);
const duckSearchTimeout = Math.floor(20000 + Math.random() * 10000 + clusterInstanceId * 1000); // 20-30 seconds from start, duck has strict rate limits

// Connection URL
const url = process.env.MONGODB_URI;
const client = new MongoClient(url);

const dbName = 'yt-indexer'; // Database Name
const urlCountMax = 50000; // Max urls to store until cache reset

// Regex to extract all YouTube urls
const ytUrlRegex = /(https?:\/\/([^=]*)youtu([^=]*)[^ ]*)/g;

// Regex to extract YouTube video IDs
const ytVideoIDRegex = /.*(?:youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=)([^#\&\?]*).*/;

// List of possible user agents we can use to spoof requests
const spoofUserAgents = [
  'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.111 Safari/537.36',
  'Mozilla/5.0 (X11; CrOS x86_64 8172.45.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/51.0.2704.64 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.61 Safari/537.36',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:15.0) Gecko/20100101 Firefox/15.0.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:77.0) Gecko/20100101 Firefox/77.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.97 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:77.0) Gecko/20100101 Firefox/77.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.97 Safari/537.36',
];

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

function buildVideoUri(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function cleanYTUri(uri) {
  return uri.replace('https://www.youtube.com/oembed?url=', '').replace('&format=json', '');
}

// Takes a video ID (or generates a random one) and creates an oembed URI that we can use
// to gather public metadata of the video. Then it will insert the URI into the crawler que
async function crawlYTVideo(crawler, videosCollection, id, highPriority = 1) {
  // If queue is already processing quite a few requests then dont generate
  // random videos URIs. Set a timeout to check again later
  if (!id && (skipAddingNew || crawler.queueSize > 64)) {
    // console.log('Queue size too large, skipping random video ID generation');
    setTimeout(() => {
      crawlYTVideo(crawler, videosCollection);
    }, 5000);
    return;
  }

  // We use oembed here to check if a YouTube video is valid, and if so get some basic info
  const videoUri = buildVideoUri(id || randomVideoId());
  const url = `https://www.youtube.com/oembed?url=${videoUri}&format=json`;
  if (id) { // Insert known ID with a high priority (1) to the crawler
    const videoUri = cleanYTUri(url);
    insertVideo(videosCollection, { uri: videoUri });
    crawlURI(crawler, url, highPriority);
  } else {
    // Insert with random priority so that we can still process
    // some random URIs even if random search is producing alot of results
    crawlURI(crawler, url, crypto.randomInt(highPriority, 3));
  }

  // ID wasnt provided, assuming wanting to continue the random
  // generation infinite loop
  if (!id) {
    setTimeout(() => {
      crawlYTVideo(crawler, videosCollection);
    }, 50);
  }
}

// Gets a random word from the dictionary and searches it with the
// innertube API. It will add the video uris to the crawler que at high priority
async function crawlRandomYTSearch(crawler, videosCollection) {
  // Set skip adding new if que is too large until its nearly all been processed
  if (!skipAddingNew && crawler.queueSize > 256) {
    skipAddingNew = true;
  } else if (skipAddingNew && crawler.queueSize <= 4) {
    skipAddingNew = false;
  }

  // If que is growing too fast, dont perform more random searches
  if (!skipAddingNew) {
    const randomQueryString = wordsList[crypto.randomInt(0, wordsListCount)];
    console.log('Searching YouTube for:', randomQueryString);

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
    crawlRandomYTSearch(crawler, videosCollection);
  }, youtubeSearchTimeout);
}

async function crawlRandomDuckDuckGoSearch(crawler, videosCollection, nextRequest = {
  q: 'site:youtube.com/watch?v=' + randomChar(),
}) {
  // Fire off a POST request to DuckDuckGo's HTML site with prebuilt params or a random query
  let data;
  try {
    console.log('Searching DuckDuckGo for:', nextRequest.q, nextRequest.s)
    data = (await axios({
      method: 'POST',
      url: 'https://html.duckduckgo.com/html/',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': spoofUserAgents[Math.floor(Math.random() * (spoofUserAgents.length - 1))],
        'authority': 'html.duckduckgo.com',
        'cache-control': 'max-age=0',
        'sec-ch-ua': ';Not A Brand";v="99", "Chromium";v="94"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': 'Linux',
        'origin': 'https://html.duckduckgo.com',
        'upgrade-insecure-requests': '1',
        'dnt': '1',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-user': '?1',
        'sec-fetch-dest': 'document',
        'referer': 'https://html.duckduckgo.com/',
        'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'sec-gpc': '1',
      },
      data: qs.stringify(nextRequest),
    })).data;
  } catch (e) {
    console.error('Unable to ping duckduckgo, error:', e.message, e.data);
  }

  let nextRequestData;
  if (data) {
    // Parse HTML contents with cheerio to extract next request data
    const $ = cheerio.load(data);
    const nextFormInputFields = $('form[action=\'/html/\'] :input[type=hidden]');

    if (nextFormInputFields && nextFormInputFields.length > 0) {
      nextRequestData = {};
      nextFormInputFields.map((index) => {
        const field = nextFormInputFields[index].attribs;
        nextRequestData[field.name] = field.value;
      });
    }

    // Extract all youtube video IDs from HTML
    // then adds the known video IDs to the crawler
    const ytUrlMatches = data.match(ytUrlRegex);
    if (ytUrlMatches) {
      const videoIds = ytUrlMatches.map(url => {
        const urlIdMatches = url.match(ytVideoIDRegex);
        if (urlIdMatches && urlIdMatches.length >= 2) {
          const videoId = urlIdMatches[1].substr(0, 11);
          return videoId;
        }
      })
      .filter((url, index, self) => self.indexOf(url) === index);

      // Consider these URLS as highest priority (0)
      videoIds.forEach(videoId => crawlYTVideo(crawler, videosCollection, videoId, 0));
      console.log('Added', videoIds.length, 'duck videos');
    } else {
      console.error('Unable to parse duck YT matches, assuming no more results. Switching query...');
      nextRequestData = undefined;
    }
  }

  // Wait a bit before searching next page
  setTimeout(() => {
    crawlRandomDuckDuckGoSearch(crawler, videosCollection, nextRequestData);
  }, duckSearchTimeout);
}

async function insertVideo(videosCollection, { uri, title = '', authorName = '', authorUrl = '', description = '' }) {
  try {
    await videosCollection.updateOne({ uri }, {
      $set: {
        uri,
        title,
        authorName,
        authorUrl,
        description,
      },
    }, { upsert: true });
  } catch (e) {
    console.error(e);
  }
}

// Callback for when a page has been crawled
// typically would be omebed JSON or RSS feed
async function onCrawled(error, res, done, opts) {
  try {
    const { uri } = res.options;
    const { crawler, videosCollection } = opts;
    const videoUri = cleanYTUri(uri);
    if (error || res.statusCode === 500) {
      failedCounter++;
      console.error(error || `Server error: ${res.statusCode} ${res.body} ${uri}`);
      done();
      return;
    }

    if (res.statusCode === 401 || res.body === 'Unauthorized') {
      // Unauthorized means that the video exists but is flagged as not embeddable
      // only way to get info would be through the youtube API - which we can do later
      // so for now lets just store it in the database as a valid uri
      // console.log('\nCrawled unauthed URI:', uri);
      insertVideo(videosCollection, { uri: videoUri });
    } else if (res.statusCode === 200) {
      const { title, author_name, author_url } = JSON.parse(res.body);
      // console.log('\nIndexed URI:', videoUri);

      // Insert video in the background
      insertVideo(videosCollection, {
        uri: videoUri,
        title,
        authorName: author_name,
        authorUrl: author_url,
        description: '',
      });

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
  console.log('Creating indices on collection...');
  await videosCollection.createIndex({ uri: 1 }, { unique: true });
  await videosCollection.createIndex({
    title: 'text',
    authorUrl: 'text',
    authorName: 'text',
    description: 'text',
  }, {
    default_language: 'none',
  });

  // Crawler object def
  console.log('Creating crawler object...');
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
  console.log('Initializing fastify...');
  fastify.get('/', (request, reply) => {
    reply.send({
      total: crawledURIs.length,
      queueSize: crawler.queueSize,
      indexedCount: urlCounter,
      failed: failedCounter,
    });
  });

  // Run the server!
  const serverPort = parseInt(process.env.PORT || 8080, 10) + clusterInstanceId;
  fastify.listen(serverPort, process.env.BIND_IP || '0.0.0.0', (err, address) => {
    if (err) {
      throw err;
    }

    console.log(`Server is now listening on ${address}`);
  });

  // Do some crawling
  console.log('Starting crawling...');
  console.log('Youtube timeout:', youtubeSearchTimeout / 1000)
  console.log('Duck timeout:', duckSearchTimeout / 1000)
  if (!process.env.DISABLE_SEARCH) {
    // Launch duck searches, for clusters we stagger the start so that
    // cluster 0 is immediate, cluster 1 is 8 seconds later, cluster 2 is 16 seconds later, etc
    if (!process.env.DISABLE_DUCK_SEARCH) {
      setTimeout(() => {
        crawlRandomDuckDuckGoSearch(crawler, videosCollection);
      }, clusterInstanceId * 7000); // Every 7 seconds a cluster instance will fire
    }

    // Launch YT searches
    if (!process.env.DISABLE_YT_SEARCH) {
      setTimeout(() => {
        crawlRandomYTSearch(crawler, videosCollection);
      }, clusterInstanceId * 3000);
    }
  }
  crawlYTVideo(crawler, videosCollection);
}

main();
