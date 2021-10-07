'use strict';

const cron = require('node-cron');

const register = require('react-server-dom-webpack/node-register');
register();
const babelRegister = require('@babel/register');

babelRegister({
    ignore: [/[\\\/](build|server|node_modules)[\\\/]/],
    presets: [['react-app', {runtime: 'automatic'}]],
    plugins: ['@babel/transform-modules-commonjs'],
});

const express = require('express');
const compress = require('compression');
const {readFileSync} = require('fs');
const {unlink, writeFile} = require('fs').promises;
const {pipeToNodeWritable} = require('react-server-dom-webpack/writer');
const path = require('path');
const {Pool} = require('pg');
const React = require('react');
const ReactApp = require('../src/App.server').default;

// Don't keep credentials in the source tree in a real app!
const pool = new Pool(require('../credentials'));

let PORT = 80;
const app = express();

app.use(compress());
app.use(express.json());

// HTTP
app
    .listen(PORT, () => {
        console.log(`React Notes listening at ${PORT}...`);
    })
    .on('error', function (error) {
        if (error.syscall !== 'listen') {
            throw error;
        }
        const isPipe = (portOrPipe) => Number.isNaN(portOrPipe);
        const bind = isPipe(PORT) ? 'Pipe ' + PORT : 'Port ' + PORT;
        switch (error.code) {
            case 'EACCES':
                console.error(bind + ' requires elevated privileges');
                process.exit(1);
                break;
            case 'EADDRINUSE':
                console.error(bind + ' is already in use');
                process.exit(1);
                break;
            default:
                throw error;
        }
    });

// HTTPS
let server = app;
let https = (process.env.PROTOCOL === "https:");
if (https) {
    PORT = 443;
    let https = require('https');
    let fs = require('fs');
    let options = {
        key: fs.readFileSync(__dirname + '/privkey.pem'),
        cert: fs.readFileSync(__dirname + '/fullchain.pem'),
    }
    server = https.createServer(options, app);
}
server
    .listen(PORT, () => {
        console.log(`React Notes listening at ${PORT}...`);
    })
    .on('error', function (error) {
        if (error.syscall !== 'listen') {
            throw error;
        }
        const isPipe = (portOrPipe) => Number.isNaN(portOrPipe);
        const bind = isPipe(PORT) ? 'Pipe ' + PORT : 'Port ' + PORT;
        switch (error.code) {
            case 'EACCES':
                console.error(bind + ' requires elevated privileges');
                process.exit(1);
                break;
            case 'EADDRINUSE':
                console.error(bind + ' is already in use');
                process.exit(1);
                break;
            default:
                throw error;
        }
    });

function handleErrors(fn) {
    return async function (req, res, next) {
        try {
            return await fn(req, res);
        } catch (x) {
            console.log(x);
            next(x);
        }
    };
}

app.get(
    '/root',
    handleErrors(async function (_req, res) {
        await waitForWebpack();
        const html = readFileSync(
            path.resolve(__dirname, '../build/index.html'),
            'utf8'
        );
        // Note: this is sending an empty HTML shell, like a client-side-only app.
        // However, the intended solution (which isn't built out yet) is to read
        // from the Server endpoint and turn its response into an HTML stream.
        res.send(html);
    })
);

async function renderReactTree(res, props) {
    await waitForWebpack();
    const manifest = readFileSync(
        path.resolve(__dirname, '../build/react-client-manifest.json'),
        'utf8'
    );
    const moduleMap = JSON.parse(manifest);
    pipeToNodeWritable(React.createElement(ReactApp, props), res, moduleMap);
}

function sendResponse(req, res, redirectToId) {
    const location = JSON.parse(req.query.location);
    if (redirectToId) {
        location.selectedId = redirectToId;
    }
    res.set('X-Location', JSON.stringify(location));
    renderReactTree(res, {
        selectedId: location.selectedId,
        isEditing: location.isEditing,
        searchText: location.searchText,
        selectedTitle: location.selectedTitle,
        selectedBody: location.selectedBody,
        userId: location.userId,
        token: location.token,
        lang: location.lang,
    });
}

app.get('/react', function (req, res) {
    sendResponse(req, res, null);
});

const NOTES_PATH = path.resolve(__dirname, '../notes');

const auth = async (user_id, token) => {
    const {rows} = await pool.query(
        `select count(*) as result
         from users
         where user_id = $1
           and token = $2`,
        [
            user_id, token
        ]
    );
    return (rows[0].result == 1);
}

app.post(
    '/bookmarks',
    handleErrors(async function (req, res) {
        if (await auth(req.body.user_id, req.body.token) === false) {
            sendResponse(req, res, null);
            return;
        }

        const now = new Date();
        const result = await pool.query(
            'insert into bookmarks (user_id, video_id, created_at, updated_at) values ($1, $2, $3, $3) returning bookmark_id',
            [req.body.user_id, req.body.video_id, now]
        );

        const insertedId = result.rows[0].bookmark_id;

        sendResponse(req, res, null);
    })
);

app.post(
    '/users',
    handleErrors(async function (req, res) {
        const user_id = req.body.user_id;
        const token = req.body.token;
        const now = new Date();
        let returnId = "";

        const resultUpdate = await pool.query(
            'update users set token = $2, memo = $1, updated_at = $3 where user_id = $1 returning user_id',
            [user_id, token, now]
        );

        if (!resultUpdate || resultUpdate.rowCount == 0) {
            const resultInsert = await pool.query(
                'insert into users (token, memo, created_at, updated_at, user_id) values ($2, $1, $3, $3, $4) returning user_id',
                [user_id, token, now, user_id]
            );

            returnId = resultInsert.rows[0].user_id;
        } else {
            returnId = resultUpdate.rows[0].user_id;
        }

        sendResponse(req, res, returnId);
    })
);

app.put(
    '/users/:id',
    handleErrors(async function (req, res) {
        const user_id = req.body.user_id;
        const token = req.body.token;
        const now = new Date();
        const updatedId = Number(req.params.id);

        const resultUpdate = await pool.query(
            'update users set token = $2, memo = $1, updated_at = $3 where user_id = $4 returning user_id',
            [user_id, token, now, updatedId]
        );

        if (!resultUpdate.rows[0].bookmark_id) {
            await pool.query(
                'insert into users (user_id, token, created_at, updated_at) values ($1, $2, $3, $3) returning user_id',
                [user_id, token, now]
            );
        }

        sendResponse(req, res, null);
    })
);

app.delete(
    '/users/:id',
    handleErrors(async function (req, res) {
        if (await auth(req.body.user_id, req.body.token) === false) {
            sendResponse(req, res, null);
            return;
        }

        await pool.query('delete from users where id = $1', [req.params.id]);

        sendResponse(req, res, null);
    })
);

app.delete(
    '/bookmarks/:id',
    handleErrors(async function (req, res) {
        if (await auth(req.body.user_id, req.body.token) === false) {
            sendResponse(req, res, null);
            return;
        }

        await pool.query('delete from bookmarks where bookmark_id = $1', [req.params.id]);

        sendResponse(req, res, null);
    })
);

app.get(
    '/notes',
    handleErrors(async function (_req, res) {
        const {rows} = await pool.query('select * from notes order by id desc');
        res.json(rows);
    })
);

app.get(
    '/notes/:id',
    handleErrors(async function (req, res) {
        const {rows} = await pool.query('select * from notes where id = $1', [
            req.params.id,
        ]);
        res.json(rows[0]);
    })
);

app.get('/sleep/:ms', function (req, res) {
    setTimeout(() => {
        res.json({ok: true});
    }, req.params.ms);
});

app.use(express.static('build'));
app.use(express.static('public'));

async function waitForWebpack() {
    while (true) {
        try {
            readFileSync(path.resolve(__dirname, '../build/index.html'));
            return;
        } catch (err) {
            console.log(
                'Could not find webpack build output. Will retry in a second...'
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}

app.get(
    '/cron',
    handleErrors(async function (req, res) {
        res.json({
            result: "true",
        });
    })
);

cron.schedule('*/5 * * * *', () => {
});

app.get(
    '/redirect',
    handleErrors(async function (req, res) {
        let url = req.query.url;

        res.redirect(url);
    })
);


