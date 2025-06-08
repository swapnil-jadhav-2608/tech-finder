
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer =require('puppeteer');


// IMPORTANT: Replace with your actual ScrapingDog API key
const SCRAPINGDOG_API_KEY = '';

// The Google search query term.
const SEARCH_QUERY = 'vmware';

// Maximum crawl depth for each starting URL.
const MAX_CRAWL_DEPTH = 3;

// **MODIFIED**: Maximum number of UNIQUE keywords to find PER DOMAIN before stopping.
const MAX_KEYWORDS_PER_DOMAIN = 3;

// Delay in milliseconds between requests to be polite to servers.
const REQUEST_DELAY = 1500;

// File and Directory Paths
const WEBSITES_FILE = 'input.csv';
const KEYWORDS_FILE = 'keywords.json';
const RESULTS_DIR = 'saved_google';
const RESULTS_CSV = 'results.csv';

// --- HELPER FUNCTIONS ---

/**
 * A simple promise-based delay function.
 * @param {number} ms - The number of milliseconds to wait.
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Ensures a directory exists, creating it if necessary.
 * @param {string} dirPath - The path to the directory.
 */
const ensureDirectoryExists = async (dirPath) => {
    try {
        await fs.access(dirPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(dirPath, { recursive: true });
            console.log(`Created directory: ${dirPath}`);
        } else {
            throw error;
        }
    }
};

/**
 * Performs a site-specific Google search using the ScrapingDog API.
 * @param {string} domain - The domain to search within.
 * @returns {object|null} The JSON response from the API, or null on failure.
 */
const performGoogleSearch = async (domain) => {
    const searchQuery = `site:${domain} ${SEARCH_QUERY}`;
    const url = `https://api.scrapingdog.com/google?api_key=${SCRAPINGDOG_API_KEY}&query=${encodeURIComponent(searchQuery)}`;
    console.log(`🔍 Searching for: "${searchQuery}"`);
    try {
        const response = await axios.get(url, { timeout: 30000 });
        if (response.data) {
            const filePath = path.join(RESULTS_DIR, `${domain}.json`);
            await fs.writeFile(filePath, JSON.stringify(response.data, null, 2));
            console.log(`✅ Saved Google search results to: ${filePath}`);
            return response.data;
        }
        return null;
    } catch (error) {
        console.error(`❌ Error searching for domain ${domain}:`, error.message);
        return null;
    }
};

/**
 * Extracts organic search result URLs from the saved JSON file.
 * @param {object} searchData - The JSON object from the Google search.
 * @returns {string[]} An array of URLs.
 */
const extractUrls = (searchData) => {
    const results = searchData.organic_results || searchData.organic_data;
    if (!results || results.length === 0) {
        console.warn('⚠️ No organic results found in search data.');
        return [];
    }
    return results.map(result => result.link).filter(Boolean);
};


/**
 * Crawls a single page, trying with Axios/Cheerio first, then falling back to Puppeteer.
 * @param {string} url - The URL to crawl.
 * @param {object} browser - The Puppeteer browser instance.
 * @returns {string|null} The page's body content as a string, or null on failure.
 */
async function fetchPageContent(url, browser) {
    try {
        const { data: html } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 15000
        });

        if (html && html.toLowerCase().includes('<body') && html.length > 500) {
            console.log(`    ... successfully fetched with Axios: ${url}`);
            return html;
        }
    } catch (error) {
        console.warn(`    ... Axios failed for ${url} (${error.message}). Retrying with Puppeteer.`);
    }

    let page = null;
    try {
        page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        const content = await page.content();
        console.log(`    ... successfully fetched with Puppeteer: ${url}`);
        return content;
    } catch (error) {
        console.error(`    ... ❌ Puppeteer failed for ${url}:`, error.message);
        return null;
    } finally {
        if (page) {
            await page.close();
        }
    }
}

/**
 * Searches the text content of a page for a list of keywords.
 * @param {string} pageText - The text content of the page.
 * @param {string[]} keywordsToSearch - The array of keywords to search for.
 * @returns {string[]} An array of found keywords.
 */
const searchKeywordsOnPage = (pageText, keywordsToSearch) => {
    if (!pageText) return [];

    const foundKeywords = new Set();
    const lowerCaseText = pageText.toLowerCase();

    for (const keyword of keywordsToSearch) {
        if (lowerCaseText.includes(keyword.toLowerCase())) {
            foundKeywords.add(keyword);
        }
    }
    return Array.from(foundKeywords);
};


// --- MAIN EXECUTION LOGIC ---

(async () => {
    // 1. Initialization
    await ensureDirectoryExists(RESULTS_DIR);
    await fs.writeFile(RESULTS_CSV, 'domain,keyword,reference_url\n');
    console.log('--- Crawler Initialized ---');

    const websitesData = await fs.readFile(WEBSITES_FILE, 'utf-8');
    const domains = websitesData.split(/\r?\n/).filter(line => line.trim() !== '');

    const keywordsData = await fs.readFile(KEYWORDS_FILE, 'utf-8');
    const allKeywords = JSON.parse(keywordsData);

    console.log(`Loaded ${domains.length} domains and ${allKeywords.length} keywords.`);

    // 2. Process each domain sequentially
    for (const domain of domains) {
        console.log(`\n--- Processing Domain: ${domain} ---`);
        const visitedUrls = new Set();
        // **NEW**: Track unique keywords found for this specific domain.
        const foundKeywordsForDomain = new Set();
        let puppeteerBrowser = null;

        try {
            // Step 1: Google Search
            const searchResults = await performGoogleSearch(domain);
            if (!searchResults) continue;

            // Step 2: Extract URLs
            const urlsToCrawl = extractUrls(searchResults);
            if (urlsToCrawl.length === 0) {
                console.log(`No URLs to crawl for ${domain}. Moving to next.`);
                continue;
            }

            console.log('🚀 Launching Puppeteer instance for this domain...');
            puppeteerBrowser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            // Step 3 & 4: Crawl and Search Keywords
            const crawlQueue = urlsToCrawl.map(url => ({ url, depth: 1 }));

            while (crawlQueue.length > 0) {
                // **NEW**: Check if we have already found enough keywords for this domain.
                if (foundKeywordsForDomain.size >= MAX_KEYWORDS_PER_DOMAIN) {
                    console.log(`✅ Limit of ${MAX_KEYWORDS_PER_DOMAIN} unique keywords reached for ${domain}. Moving to next domain.`);
                    break; // Exit the crawling loop for this domain
                }

                const { url, depth } = crawlQueue.shift();

                if (visitedUrls.has(url) || depth > MAX_CRAWL_DEPTH) {
                    continue;
                }

                console.log(`  Crawling (depth ${depth}): ${url}`);
                visitedUrls.add(url);

                let pageContent = await fetchPageContent(url, puppeteerBrowser);

                if (pageContent) {
                    // **NEW**: Determine which keywords we still need to search for.
                    const keywordsToSearch = allKeywords.filter(k => !foundKeywordsForDomain.has(k));

                    if (keywordsToSearch.length > 0) {
                        const $ = cheerio.load(pageContent);
                        const pageText = $('body').text();

                        // Search for the remaining keywords on the current page
                        const newlyFoundKeywords = searchKeywordsOnPage(pageText, keywordsToSearch);

                        if (newlyFoundKeywords.length > 0) {
                            console.log(`    ✅ Found new keywords: [${newlyFoundKeywords.join(', ')}] on ${url}`);

                            // Add newly found keywords to the domain-level set and log them
                            const csvRows = newlyFoundKeywords.map(k => {
                                foundKeywordsForDomain.add(k);
                                return `${domain},${k},${url}`;
                            }).join('\n');
                            await fs.appendFile(RESULTS_CSV, csvRows + '\n');
                        }
                    }

                    // Enqueue new links for crawling if not at max depth and we still need keywords
                    if (depth < MAX_CRAWL_DEPTH && foundKeywordsForDomain.size < MAX_KEYWORDS_PER_DOMAIN) {
                        const $ = cheerio.load(pageContent);
                        $('a').each((i, link) => {
                            const href = $(link).attr('href');
                            if (href) {
                                try {
                                    const nextUrl = new URL(href, url);
                                    if (nextUrl.hostname.endsWith(domain) && !visitedUrls.has(nextUrl.href)) {
                                        crawlQueue.push({ url: nextUrl.href, depth: depth + 1 });
                                    }
                                } catch (e) {
                                    // Ignore invalid URLs
                                }
                            }
                        });
                    }
                    pageContent = null;
                }
                await delay(REQUEST_DELAY);
            }
        } catch (error) {
            console.error(`❌ An unexpected error occurred while processing ${domain}:`, error);
        } finally {
            // Step 5: Memory & Performance Cleanup
            console.log(`--- Cleaning up resources for ${domain} ---`);
            if (puppeteerBrowser) {
                console.log('🔒 Closing Puppeteer instance...');
                await puppeteerBrowser.close();
                puppeteerBrowser = null;
            }
            if (global.gc) {
                console.log('🧹 Triggering manual garbage collection...');
                global.gc();
            } else {
                console.warn('⚠️ Manual garbage collection is not available. Run with --expose-gc flag.');
            }
        }
    }
    console.log('\n--- All domains processed. Script finished. ---');
})();
