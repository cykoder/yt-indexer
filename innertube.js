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

export default function searchYoutube(query) {
  const searchParams = {
    ...baseParams,
    query,
  };

  const apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // TODO: fetch api key from youtube.com source code, extract "innertubeApiKey":" 
  return axios.post('https://www.youtube.com/youtubei/v1/search?key=' + apiKey, searchParams);
}
