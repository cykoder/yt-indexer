# Experimental YouTube video indexer

This program will generate random video IDs and perform random youtube searches then index video details into MongoDB if the video exists and is public. When a video is scraped, an RSS feed of the author's channel is sometimes pulled and will scrape the latest 50 or so videos from that channel. The purpose of this is to experiment and build a collection of YouTube video metadata/uris without crawling public web pages for future hack projects.

It averages about 1.4k DB writes a minute running on a low end VPS with 4 instances running in cluster mode.
