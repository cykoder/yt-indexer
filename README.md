# Experimental YouTube video indexer

This program generates random video IDs and perform random youtube/duckduckgo searches using a words list or suggested queries. It will then index video details into MongoDB if the video exists and is embeddable, otherwise it will just store a valid video URI. When a video is scraped, an RSS feed of the author's channel is sometimes pulled and will scrape the latest 50 or so videos from that channel. The purpose of this is to experiment and build a collection of YouTube video metadata/uris without crawling public web pages for future hack projects.

It averages about 10k valid URL DB writes a minute running on a low end VPS with 8 instances running in cluster mode.

It can be configured with the following environment variables, typically through a `.env` file:

| Key         | Required     | Description |
|--------------|-----------|------------|
| DISABLE_UNNOWN_GATHER | false     | Disables gathering unknown YT videos from DB       |
| DISABLE_MANUALQUERY | false     | Disables manual queries from DB searching       |
| DISABLE_RANDOMHASH | false     | Disables randomly generating video IDs       |
| DISABLE_YT_SEARCH | false     | Disables searching on youtube by random queries       |
| DISABLE_DUCK_SEARCH | false     | Disables searching on DuckDuckGo for YT urls       |
| DISABLE_SEARCH | false     | Disables all search (DISABLE_YT_SEARCH and DISABLE_DUCK_SEARCH)       |
| DISABLE_METADATA_GATHER | false     | Disables gathering video metadata, will only insert uris       |
| YOUTUBE_TIMEOUT_MIN | false     | How long between youtube searches       |
| FULL_INFO_GATHER_TIMEOUT | false     | How long between doing full YT data gathers       |
| BIND_IP | false     | Bind IP for JSON stats       |
| PORT | false     | Port for JSON stats       |
| NODE_APP_INSTANCE | false     | Typically supplied from PM2 - cluster instance index       |
| MONGODB_URI | true     | MongoDB connection URI       |
| MAX_CONNECTIONS | false     | Maximum connections crawler can use at a time, cannot be set with rate limit       |
| RATE_LIMIT | false     | If set max connections will be set to 1 and requests will be rate limited       |
