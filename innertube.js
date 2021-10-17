import axios from 'axios';

const baseParams = {
  "context": {
    "client": {
      "hl": "en-US",
      "gl": "US",
      "remoteHost": "0.0.0.0",
      "deviceMake": "",
      "deviceModel": "",
      "visitorData": "",
      "userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.61 Safari/537.36,gzip(gfe)",
      "clientName": "WEB",
      "clientVersion": "2.20211014.05.00",
      "osName": "X11",
      "osVersion": "",
      "originalUrl": "https://www.youtube.com/",
      "screenPixelDensity": 1,
      "platform": "DESKTOP",
      "clientFormFactor": "UNKNOWN_FORM_FACTOR",
      "screenDensityFloat": 1.0,
      "timeZone": "Europe/France",
      "browserName": "Chrome",
      "browserVersion": "420",
      "screenWidthPoints": 420,
      "screenHeightPoints": 420,
      "utcOffsetMinutes": 0,
      "userInterfaceTheme": "USER_INTERFACE_THEME_LIGHT"
    },
    "user": {
      "lockedSafetyMode": false
    },
    "request": {
      "useSsl": false,
      "internalExperimentFlags": [],
      "consistencyTokenJars": []
    },
    "clickTracking": {
      "clickTrackingParams": "BCcQ7VAiEwjh_YH0m9LzAhKSsHsHKa03DuI="
    },
    "adSignalsInfo": {
      "params": []
    }
  },
};

const apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // TODO: fetch api key from youtube.com source code, extract "innertubeApiKey":"

export async function loadContinuimVideos(query, continuation) {
  const continueData = await axios.post('https://www.youtube.com/youtubei/v1/search?key=' + apiKey, {
    ...baseParams,
    continuation,
  });

  const continuedVideoList = continueData.data.onResponseReceivedCommands[0]
    .appendContinuationItemsAction.continuationItems[0]
    .itemSectionRenderer.contents
    .map(item => item.videoRenderer && item.videoRenderer.videoId)
    .filter(item => !!item);
  return continuedVideoList;
}

export default async function searchYoutube(query) {
  const { data } = await axios.post('https://www.youtube.com/youtubei/v1/search?key=' + apiKey, {
    ...baseParams,
    query,
  });

  let continuedVideos = [];
  const estCount = parseInt(data.estimatedResults, 10);
  if (estCount > 20) {
    const continuation = data.contents.twoColumnSearchResultsRenderer.primaryContents
      .sectionListRenderer.contents[1].continuationItemRenderer
      .continuationEndpoint.continuationCommand.token;
    try {
      continuedVideos = await loadContinuimVideos(query, continuation);
    } catch (e) {
      console.error(e);
    }
  }

  const videoList = data.contents.twoColumnSearchResultsRenderer
    .primaryContents.sectionListRenderer.contents
    .filter(item => !!item.itemSectionRenderer)[0]
    .itemSectionRenderer.contents
    .map(item => item.videoRenderer && item.videoRenderer.videoId)
    .filter(item => !!item);

  return [...videoList, ...continuedVideos];
}
