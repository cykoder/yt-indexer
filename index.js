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
import randomUseragent from 'random-useragent';
import { searchYoutube, getQuerySuggestions } from './innertube.js';

// Load config from .env
dotenv.config({ path: './.env' });

// Numerical ID of this instance in cluster mode or 0 otherwise
const clusterInstanceId = parseInt(process.env.NODE_APP_INSTANCE || 0, 10);

// Load words list for random searches
const wordsList = fs.readFileSync('./words.txt', {encoding: 'utf8', flag: 'r'}).split('\n');
const wordsListCount = wordsList.length;

// Random timeout for searches to spread requests across instances
const YOUTUBE_TIMEOUT_MIN = parseInt(process.env.YOUTUBE_TIMEOUT_MIN || 500, 10);
const youtubeSearchTimeout = () => Math.floor(YOUTUBE_TIMEOUT_MIN + Math.random() * YOUTUBE_TIMEOUT_MIN);
const duckSearchTimeout = (rateLimited) => Math.floor(20000 + Math.random() * 30000) + (rateLimited ? 60000 : 0);

// Connection URL
const url = process.env.MONGODB_URI;
const client = new MongoClient(url);

const dbName = 'yt-indexer'; // Database Name
const urlCountMax = 50000; // Max urls to store until cache reset

// Regex to extract all YouTube urls
const ytUrlRegex = /(https?:\/\/([^=]*)youtu([^=]*)[^ ]*)/g;

// Regex to extract YouTube video IDs
const ytVideoIDRegex = /.*(?:youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=)([^#\&\?]*).*/;

let crawledURIs = []; // In memory cache of crawled URIs
let skipAddingNew = false;
let failedCounter = 0;
let urlCounter = 0;
const suggestedQueries = [];

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
function crawlURI(crawler, uri, priority = 5, requestOptions = {}) {
  if (crawledURIs.indexOf(uri) === -1) {
    crawledURIs.push(uri);

    if (!process.env.DISABLE_METADATA_GATHER) {
      crawler.queue(uri, {
        priority,
        ...requestOptions,
        headers: generateRandomHeaders(null, 'www.youtube.com'),
      });
    }
  }
}

function buildVideoUri(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function cleanYTUri(uri) {
  return uri.replace('https://www.youtube.com/oembed?url=', '').replace('&format=json', '');
}

function generateRandomHeaders(userAgent, origin = '') {
  return {
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': userAgent || randomUseragent.getRandom(),
    'authority': origin,
    'cache-control': 'max-age=0',
    'origin': `https://${origin}`,
    'upgrade-insecure-requests': '1',
    'dnt': '1',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
    'referer': `https://${origin}/`,
    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'sec-gpc': '1',
  };
}

// This method fires every so often to gather full video information from youtube for unknown videos
// since the rate limits kick in often for non-oembed urls, we have to stagger full info requests
async function gatherVideoDetails(crawler, videosCollection) {
  // Crawl again later
  const videoCount = 4;
  setTimeout(() => {
    gatherVideoDetails(crawler, videosCollection);
  }, videoCount * 2000);

  console.log('Gathering video details for unknown titles/descriptions...');
  const unknownVideos = await videosCollection.find({
    $and: [{
      $or: [
        { title: null },
        { title: '' },
      ]
    }, {
      $or: [
        { description: null },
        { description: '' },
      ]
    }]
  }).limit(videoCount).toArray();

  unknownVideos.forEach((video, i) => crawlURI(crawler, video.uri, 0, {
    timeout: i * 1000,
  }));
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
  const url =  `https://www.youtube.com/oembed?url=${videoUri}&format=json`;
  if (id) { // Insert known ID with a high priority (1) to the crawler
    if (crawledURIs.indexOf(url) !== -1) { // Early out if already crawled/crawling
      return;
    }

    // Check video URI doesnt exist in database with information before adding to crawler
    const videoUri = cleanYTUri(url);
    const foundVideo = await videosCollection.count({ uri: videoUri, title: {'$exists': true, '$ne' : ''}});
    if (foundVideo === 0) {
      // Insert video uri incase of program exit so that valid URL is saved somewhere
      insertVideo(videosCollection, { uri: videoUri });
      crawlURI(crawler, url, highPriority);
    }
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

async function crawlSuggestions(query) {
  console.log('Crawling suggestions', query)
  try {
    const suggestions = await getQuerySuggestions(query);
    if (suggestions.length > 0) {
      for (let i = 0; i < suggestions.length; i++) {
        if (suggestedQueries.indexOf(suggestions[i]) === -1) {
          suggestedQueries.push(suggestions[i]);
        }
      }
    }
  } catch (e) {
    console.error('Unable to get suggestions:', e.message)
  }
}

// Searches a query string on youtube and adds to crawler
async function addFromYoutubeSearch(crawler, videosCollection, randomQueryString, highPriority, hasSuggestedQuery) {
  console.log('Searching YouTube for:', randomQueryString);

  // Try get query suggestions for extra search queries
  if (!hasSuggestedQuery) {
    crawlSuggestions(randomQueryString);
  }

  // Search youtube for this query string
  try {
    const videoList = await searchYoutube(randomQueryString);
    for (let i = 0; i < videoList.length; i++) {
      const videoId = videoList[i];
      if (videoId) {
        crawlYTVideo(crawler, videosCollection, videoId, highPriority);
      }
    }
    console.log('Added', videoList.length, 'videos with query', randomQueryString);
  } catch (e) {
    console.error('Unable to crawl random search:', e.message)
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

  // Set to fire this method again soon
  setTimeout(() => {
    crawlRandomYTSearch(crawler, videosCollection);
  }, youtubeSearchTimeout());

  // If que is growing too fast, dont perform more random searches
  if (!skipAddingNew) {
    const hasSuggestedQuery = suggestedQueries.length > 0;
    const randomQueryString = hasSuggestedQuery ?
      suggestedQueries.pop() : // Get suggested query
      wordsList[crypto.randomInt(0, wordsListCount)]; // Get random word
    await addFromYoutubeSearch(crawler, videosCollection, randomQueryString, undefined, hasSuggestedQuery);
  } else {
    console.log('Queue size too large, skipping random video search');
  }
}

async function crawlRandomDuckDuckGoSearch(crawler, videosCollection, nextRequest = {
  q: 'site:youtube.com/watch?v=' + randomChar(),
}) {
  // Should we skip searches to let the que process?
  if (skipAddingNew) {
    setTimeout(() => {
      crawlRandomDuckDuckGoSearch(crawler, videosCollection, nextRequest);
    }, duckSearchTimeout());
    return;
  }

  // Fire off a POST request to DuckDuckGo's HTML site with prebuilt params or a random query
  let data;
  let userAgent;
  let isRateLimited = false;
  try {
    console.log('Searching DuckDuckGo for:', nextRequest.q, nextRequest.s)
    data = (await axios({
      method: 'POST',
      url: 'https://html.duckduckgo.com/html/',
      headers: generateRandomHeaders(nextRequest.userAgent, 'html.duckduckgo.com'),
      data: qs.stringify(nextRequest),
    })).data;
  } catch (e) {
    console.error('Unable to ping duckduckgo, error:', e.message, e.data);
    isRateLimited = true;
  }

  let nextRequestData;
  if (data) {
    // Parse HTML contents with cheerio to extract next request data
    const $ = cheerio.load(data);
    const nextFormInputFields = $('form[action=\'/html/\'] :input[type=hidden]');

    if (nextFormInputFields && nextFormInputFields.length > 0) {
      nextRequestData = { userAgent };
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
  }, duckSearchTimeout(isRateLimited));
}

async function insertVideo(videosCollection, data, crawler) {
  const { uri, authorUrl } = data;

  try {
    await videosCollection.updateOne({ uri }, {
      $set: {
        ...data,
        uri,
      },
    }, { upsert: true });
  } catch (e) {
    console.error(e);
  }


  // Get RSS feed of channel and crawl their videos
  const ytChannelStr = 'https://www.youtube.com/channel/';
  if (crawler && authorUrl && !skipAddingNew && authorUrl.substr(0, ytChannelStr.length) === ytChannelStr) {
    const channelId = authorUrl.substr(ytChannelStr.length);
    const rssUri = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    if (crawledURIs.indexOf(rssUri) === -1) {
      crawledURIs.push(rssUri);
      axios.get(rssUri)
        .then(feedResponse => {
          const { feed } = xmlParser.parse(feedResponse.data, {});
          const videoCount = feed.entry.length;
          for (let i = 0; i < videoCount; i++) {
            const feedItem = feed.entry[i];
            if (feedItem && feedItem['yt:videoId']) {
              crawlYTVideo(crawler, videosCollection, feedItem['yt:videoId']);
            }
          }
          console.log('Added', videoCount, 'channel videos for channel:', channelId)
        });
    }
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
      // console.log('\nIndexing URI:', videoUri);
      const isJSON = res.body.substr(0, 1) === '{';
      if (isJSON) {
        const { title, author_name, author_url } = JSON.parse(res.body);
        insertVideo(videosCollection, {
          uri: videoUri,
          title,
          authorName: author_name,
          authorUrl: author_url,
          description: '',
        }, crawler);
      } else {
        const videoDetailsStr = `"microformat":`;
        const videoDetailsIndex = res.body.indexOf(videoDetailsStr);
        if (videoDetailsIndex !== -1) {
          const tests = res.body.substr(videoDetailsIndex + videoDetailsStr.length);
          const endIndex = tests.indexOf(`,"trackingParams"`);
          if (endIndex === -1) {
            console.error('Unable to parse YT JSON in step 2');
          } else {
            let microformatStr = tests.substr(0, endIndex);
            const cardsIndex = microformatStr.indexOf(`,"cards"`);
            if (cardsIndex !== -1) { // Some data has extra property of cards, filter it out
              microformatStr = microformatStr.substr(0, cardsIndex);
            }

            const {
              title,
              description,
              lengthSeconds,
              ownerProfileUrl,
              externalChannelId,
              viewCount,
              category,
              uploadDate,
              ownerChannelName
            } = JSON.parse(microformatStr).playerMicroformatRenderer;

            insertVideo(videosCollection, {
              uri: videoUri,
              title: title && title.simpleText,
              authorName: ownerChannelName,
              authorUrl: externalChannelId ? `https://www.youtube.com/channel/${externalChannelId}` : ownerProfileUrl,
              description: description && description.simpleText,
              lengthSeconds: parseInt(lengthSeconds, 10),
              viewCount,
              category,
              uploadDate,
            }, crawler);
          }
        }
      }

      urlCounter++;
      if (urlCounter >= urlCountMax) {
        urlCounter = 0;
        crawledURIs = [];
      }
    } else if (res.statusCode === 429) {
      console.error('Rate limited:', uri);
    } else if (res.statusCode !== 404) {
      console.error('Unknown statuscode:', uri, res.statusCode, res.body)
      failedCounter++;
    }
  } catch (e) {
    console.error(e);
    failedCounter++;
  }
  done();
}

// Crawls user inputted queries from the database
async function crawlQueries(crawler, videosCollection, queriesCollection) {
  // Fire this method again in a little bit to check for more queries
  setTimeout(() => {
    crawlQueries(crawler, videosCollection, queriesCollection);
  }, 1000);

  // Should we skip searches to let the que process?
  if (!skipAddingNew) {
    // Find a query that has not been crawled yet, set its status as crawled and then search youtube
    const uncrawledQuery = (await queriesCollection.find({ crawlDate: { $exists: false } }).limit(1).toArray())[0];
    if (uncrawledQuery) {
      queriesCollection.updateOne({ _id: uncrawledQuery._id }, { $set: { crawlDate: new Date() } });
      await addFromYoutubeSearch(crawler, videosCollection, uncrawledQuery.query, 0);
    }
  }
}

async function main() {
  // Connect to MongoDB
  await client.connect();
  console.log('Connected successfully to database');

  // Select database and videos collection
  const db = client.db(dbName);
  const videosCollection = db.collection('videos');
  const queriesCollection = db.collection('queries');

  // Ensure DB indices exist
  console.log('Creating indices on queries collection...');
  await queriesCollection.createIndex({ query: 1 }, { unique: true });

  console.log('Creating indices on videos collection...');
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
    timeout: 7500,
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
  if (!process.env.DISABLE_SEARCH) {
    // Launch duck searches, for clusters we stagger the start so that
    // cluster 0 is immediate, cluster 1 is 8 seconds later, cluster 2 is 16 seconds later, etc
    if (!process.env.DISABLE_DUCK_SEARCH) {
      setTimeout(() => {
        crawlRandomDuckDuckGoSearch(crawler, videosCollection);
      }, clusterInstanceId * 10000); // Every 10 seconds a cluster instance will fire, immediate for ID 0
    }

    // Launch YT searches
    if (!process.env.DISABLE_YT_SEARCH) {
      setTimeout(() => {
        crawlRandomYTSearch(crawler, videosCollection);
      }, clusterInstanceId * 1500);
    }
  }

  if (!process.env.DISABLE_RANDOMHASH) {
    crawlYTVideo(crawler, videosCollection);
  }

  if (!process.env.DISABLE_MANUALQUERY) {
    crawlQueries(crawler, videosCollection, queriesCollection);
  }

  if (!process.env.DISABLE_UNNOWN_GATHER) {
    gatherVideoDetails(crawler, videosCollection);
  }
}

main();
