const http = require('http');

const fetch = require('node-fetch');

const { isProbablyReaderable, Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

const DUCKDUCKGO_URL = 'https://lite.duckduckgo.com/lite/';

const collectBody = (req) => {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
        })
        req.on('end', () => {
            resolve(data);
        });
    });
}

const removeMeta = (result) => {
    result.output = result.output.replace(/<(meta|link)[\s\S]*?\/?>/gi, '');
}

const removeScripts = (result) => {
    result.output = result.output.replace(/<script[\s\S]*?<\/script>/gi, '');
}

const modifyLinks = (result, host) => {
    result.output = result.output.replace(/http:\/\//gi, `http://${host}/?url=http://`);

    result.output = result.output.replace(/https:\/\//gi, `http://${host}/?url=https://`);
}

const cleanSearchResults = (result) => {
    // Remove formatting that takes up space
    result.output = result.output.replace(/<p.*<\/p>/gi, '<p></p>');

    // Remove where and when selects
    result.output = result.output.replace(/<select class="submit" name="kl">[\s\S]*<\/select>/gi, '');

    // Remove the written out link under each result
    result.output = result.output.replace(/<tr>\s*<td>&nbsp;&nbsp;&nbsp;<\/td>\s*<td>\s*<span class='link-text'>.*<\/span>\s*<\/td>\s*<\/tr>/gi, '');

    // Remove img
    result.output = result.output.replace(/<img[\s\S]*?\/?>/gi, '');
}

const makeAbsolute = (data, url) => {
    const u = url.replace(/\/$/, ''); // Remove ending slash

    // RegExp adapted from https://github.com/sorensen/absolutify
    return data.replace(/((href|src|action)=["'])(?!(http|https):|(\/\/))((?:\/)?([^'"]+))/g, `$1${u}/$6`);
}

const readerableException = (url) => {
    return /eab\.abime\.net/.test(url);
}

const handleRequest = async (result, url, host) => {
    if (/(\.jpg|\.png|\.gif)/.test(url)) {
        const response = await fetch(url);
        result.output = await response.buffer();

        if (/\.jpg/.test(url)) {
            result.type = 'image/jpeg';
        } else if (/\.png/.test(url)) {
            result.type = 'image/png';
        } else if (/\.gif/.test(url)) {
            result.type = 'image/gif';
        }
    } else if (/\.css/.test(url)) {
        const response = await fetch(url);
        result.output = await response.text();

        result.type = 'text/css';
    } else if (/\.js/.test(url)) {
        result.output = ''; // We dont want any JavaScript

        result.type = 'text/javascript';
    } else {
        const response = await fetch(url);
        const data = await response.text();

        const dom = new JSDOM(data, {
            url: url
        });

        //  Check if it can be cleaned up
        if (isProbablyReaderable(dom.window.document) && !readerableException(url)) {
            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            result.output = `<html lang=en><head><title>${article.title}</title></head><body>${article.content}</body></html>`;

            console.log('Improved with Readability...');
        } else { // Otherwise return original html and hope for the best
            // Have to convert all links to absolute
            result.output = makeAbsolute(data, url);

            removeScripts(result);

            console.log('Original content with absolute URLs...');
        }

        modifyLinks(result, host);
    }
}

http.createServer(async (req, res) => {
    if (req.url !== '/favicon.ico') {
        console.log(`${req.method} ${req.url}`);
    }

    const result = {
        output: undefined,
        type: 'text/html'
    };

    if (req.method === 'GET' && req.url === '/') { // DuckDuckGo start page
        const response = await fetch(DUCKDUCKGO_URL);

        result.output = await response.text();

        removeMeta(result);
    } else if (req.method === 'POST' && req.url === '/lite/') { // DuckDuckGo search result
        const body = await collectBody(req);

        const response = await fetch(DUCKDUCKGO_URL, {
            method: 'POST',
            body: body,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        result.output = await response.text();

        removeMeta(result);

        cleanSearchResults(result);

        const host = req.headers.host;

        modifyLinks(result, host);
    } else if (req.method === 'GET' && req.url.startsWith('/?url=')) { // All other reqests goes here
        const url = req.url.split('/?url=')[1];

        const host = req.headers.host;

        await handleRequest(result, url, host);
    } else if (req.method === 'GET' && req.url === '/favicon.ico') {
        result.output = Buffer.from(''); // Return an empty icon

        result.type = 'image/x-icon';
    } else {
        console.log(`${req.method} ${req.url} Is of a typ we dont yet handle...`);

        result.output = '';

        result.type = 'text/plain';
    }

    if (result.type.startsWith('text/')) {
        res.writeHead(200, {'Content-Type': `${result.type}; charset=iso-8859-1`});
        res.write(result.output, 'latin1');
        res.end();
    } else {
        res.writeHead(200, {'Content-Type': result.type});
        res.write(result.output);
        res.end();
    }
}).listen(1986);
