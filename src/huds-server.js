#!/usr/bin/env node
/*!
**  HUDS -- Head-Up-Display Server (HUDS)
**  Copyright (c) 2020 Dr. Ralf S. Engelschall <rse@engelschall.com>
**
**  Permission is hereby granted, free of charge, to any person obtaining
**  a copy of this software and associated documentation files (the
**  "Software"), to deal in the Software without restriction, including
**  without limitation the rights to use, copy, modify, merge, publish,
**  distribute, sublicense, and/or sell copies of the Software, and to
**  permit persons to whom the Software is furnished to do so, subject to
**  the following conditions:
**
**  The above copyright notice and this permission notice shall be included
**  in all copies or substantial portions of the Software.
**
**  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
**  EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
**  MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
**  IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
**  CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
**  TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
**  SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

/*  external requirements  */
const path          = require("path")
const fs            = require("fs")
const HAPI          = require("@hapi/hapi")
const Inert         = require("@hapi/inert")
const HAPIAuthBasic = require("@hapi/basic")
const HAPIWebSocket = require("hapi-plugin-websocket")
const HAPITraffic   = require("hapi-plugin-traffic")
const HAPIHeader    = require("hapi-plugin-header")
const yargs         = require("yargs")
const chalk         = require("chalk")
const moment        = require("moment")
const resolve       = require("resolve")
const jsYAML        = require("js-yaml")
const Latching      = require("latching")
const MQTT          = require("async-mqtt")
const mixinDeep     = require("mixin-deep")
const my            = require("../package.json")

/*  create global latching instance  */
const latching = new Latching()

/*  create global HUD registry  */
const HUD = {}

/*  establísh asynchronous context  */
;(async () => {
    /*  parse command-line arguments  */
    const argv = yargs
        /* eslint indent: off */
        .usage("Usage: $0 " +
            "[-h|--help] [-V|--version] " +
            "[-l|--log-file <log-file>] [-v|--log-level <log-level>] " +
            "[-a <address>] [-p <port>] " +
            "[-b <broker>] [-r <topic>] [-s <topic>] " +
            "[-U <username>] [-P <password>] " +
            "[-d <hud-id>:<hud-directory>[,<hud-config-file>[,<hud-config-file>[,...]]]]"
        )
        .help("h").alias("h", "help").default("h", false)
            .describe("h", "show usage help")
        .boolean("V").alias("V", "version").default("V", false)
            .describe("V", "show version information")
        .string("l").nargs("l", 1).alias("l", "log-file").default("l", "-")
            .describe("l", "file for verbose logging")
        .number("v").nargs("v", 1).alias("v", "log-level").default("v", 2)
            .describe("v", "level for verbose logging (0-3)")
        .string("a").nargs("a", 1).alias("a", "address").default("a", "127.0.0.1")
            .describe("a", "IP address of service")
        .string("b").nargs("b", 1).alias("b", "broker").default("b", "")
            .describe("b", "URL of MQTT broker")
        .string("n").nargs("n", 1).alias("n", "name").default("n", "")
            .describe("n", "name of MQTT ports")
        .string("r").nargs("r", 1).alias("r", "topic-recv").default("r", "")
            .describe("r", "receive topic at MQTT broker")
        .string("s").nargs("s", 1).alias("s", "topic-send").default("s", "")
            .describe("s", "send topic at MQTT broker")
        .number("p").nargs("p", 1).alias("p", "port").default("p", 9999)
            .describe("p", "TCP port of service")
        .string("U").nargs("U", 1).alias("U", "username").default("U", "")
            .describe("U", "authenticating username for service")
        .string("P").nargs("P", 1).alias("P", "password").default("P", "")
            .describe("P", "authenticating password for service")
        .array("d").nargs("d", 1).alias("d", "define").default("d", [])
            .describe("d", "define HUD id:dir[,file]")
        .version(false)
        .strict()
        .showHelpOnFail(true)
        .demand(0)
        .parse(process.argv.slice(2))

    /*  short-circuit processing of "-V" (version) command-line option  */
    if (argv.version) {
        process.stderr.write(`${my.name} ${my.version} <${my.homepage}>\n`)
        process.stderr.write(`${my.description}\n`)
        process.stderr.write(`Copyright (c) 2020 ${my.author.name} <${my.author.url}>\n`)
        process.stderr.write(`Licensed under ${my.license} <http://spdx.org/licenses/${my.license}.html>\n`)
        process.exit(0)
    }

    /*  use last supplied option only  */
    const reduce = (id1, id2) => {
        if (typeof argv[id1] === "object" && argv[id1] instanceof Array) {
            argv[id1] = argv[id1][argv[id1].length - 1]
            argv[id2] = argv[id2][argv[id2].length - 1]
        }
    }
    reduce("l", "logFile")
    reduce("v", "logLevel")
    reduce("a", "address")
    reduce("p", "port")
    reduce("b", "broker")
    reduce("n", "name")
    reduce("r", "topicRecv")
    reduce("t", "topicSend")
    reduce("U", "username")
    reduce("P", "password")

    /*  sanity check usage  */
    if (argv.define.length === 0)
        throw new Error("no HUDs defined")

    /*  log messages  */
    const levels = [
        { name: "ERROR",   style: chalk.red.bold },
        { name: "WARNING", style: chalk.yellow.bold },
        { name: "INFO",    style: chalk.blue },
        { name: "DEBUG",   style: chalk.green }
    ]
    if (argv.logLevel >= levels.length)
        throw new Error("invalid maximum verbose level")
    let stream = null
    if (argv.logFile === "-")
        stream = process.stdout
    else if (argv.logFile !== "")
        stream = fs.createWriteStream(argv.logFile, { flags: "a", encoding: "utf8" })
    const log = (level, msg) => {
        if (level <= argv.logLevel) {
            const timestamp = moment().format("YYYY-MM-DD hh:mm:ss.SSS")
            let line = `[${timestamp}]: `
            if (stream.isTTY)
                line += `${levels[level].style("[" + levels[level].name + "]")}`
            else
                line += `[${levels[level].name}]`
            line += `: ${msg}\n`
            stream.write(line)
        }
    }

    /*  show startup message  */
    log(2, `starting Head-Up-Display Server (HUDS) ${my.version}`)

    /*  process HUD definitions  */
    const resolvePathname = async (pathname) => {
        let m
        let stat = null
        if ((m = pathname.match(/^@(.+)$/))) {
            try {
                pathname = require.resolve(m[1])
            }
            catch (err) {
                pathname = null
            }
        }
        if (pathname !== null)
            stat = await fs.promises.stat(pathname).catch(() => null)
        return { stat, pathname }
    }
    for (const spec of argv.define) {
        const m = spec.match(/^(.+?):(.+?)(?:,(.+))?$/)
        if (m === null)
            throw new Error(`invalid HUD id/directory/config combination "${spec}"`)
        const [ , id, dir, config ] = m
        if (HUD[id] !== undefined)
            throw new Error(`HUD "${id}" already defined`)
        let { stat, pathname: dirResolved } = await resolvePathname(dir)
        if (stat === null)
            throw new Error(`HUD "${id}": base path "${dir}" not found`)
        if (stat.isFile()) {
            const { stat: stat2, pathname: dirResolved2 } = await resolvePathname(path.dirname(dirResolved))
            stat = stat2
            dirResolved = dirResolved2
        }
        if (!stat.isDirectory())
            throw new Error(`HUD "${id}": base path "${dir}" not a directory`)
        log(2, `HUD definition: [${id}]: using base directory "${dirResolved}"`)
        let data = {}
        if (config) {
            const configFiles = config.split(",")
            for (const configFile of configFiles) {
                const { stat, pathname: configResolved } = await resolvePathname(configFile)
                if (stat === null)
                    throw new Error(`HUD "${id}": config path "${configFile}" not found`)
                if (!stat.isFile())
                    throw new Error(`HUD "${id}": config path "${configFile}" is not a file`)
                log(2, `HUD definition: [${id}]: reading configuration file "${configResolved}"`)
                const yaml = await fs.promises.readFile(configResolved, { encoding: "utf8" })
                const obj = jsYAML.safeLoad(yaml)
                data = mixinDeep(data, obj)
            }
        }
        HUD[id] = { dir: dirResolved, data }
        const pkg = require(path.resolve(path.join(dirResolved, "package.json")))
        if (typeof pkg.huds === "object") {
            if (typeof pkg.huds.client === "string")
                HUD[id].client = pkg.huds.client
            if (typeof pkg.huds.server === "string") {
                HUD[id].server = path.resolve(dirResolved, pkg.huds.server)
                const plugin = require(HUD[id].server)
                HUD[id].plugin = latching.use(plugin, { log, config: data })
            }
        }
    }

    /*  establish REST server  */
    log(2, `listening to REST/Websocket service http://${argv.address}:${argv.port}`)
    const server = HAPI.server({
        host:  argv.address,
        port:  argv.port,
        debug: false
    })

    /*  register HAPI plugins  */
    await server.register({ plugin: Inert })
    await server.register({ plugin: HAPIWebSocket })
    await server.register({ plugin: HAPIAuthBasic })
    await server.register({ plugin: HAPITraffic })
    await server.register({ plugin: HAPIHeader, options: { Server: `${my.name}/${my.version}` } })
    latching.hook("hapi:server", "none", server)

    /*  provide client IP address  */
    server.ext("onRequest", async (request, h) => {
        let clientAddress = "<unknown>"
        if (request.headers["x-forwarded-for"])
            clientAddress = request.headers["x-forwarded-for"]
                .replace(/^(\S+)(?:,\s*\S+)*$/, "$1")
        else
            clientAddress = request.info.remoteAddress
        request.app.clientAddress = clientAddress
        latching.hook("hapi:on-request", "none", request, h)
        return h.continue
    })

    /*  log all requests  */
    server.events.on("response", (request) => {
        const traffic = request.traffic()
        let protocol = `HTTP/${request.raw.req.httpVersion}`
        const ws = request.websocket()
        if (ws.mode === "websocket") {
            const wsVersion = ws.ws.protocolVersion || request.headers["sec-websocket-version"] || "13?"
            protocol = `WebSocket/${wsVersion}+${protocol}`
        }
        const msg =
            "request: " +
            "remote="   + request.app.clientAddress + ", " +
            "method="   + request.method.toUpperCase() + ", " +
            "url="      + request.url.pathname + ", " +
            "protocol=" + protocol + ", " +
            "response=" + (request.response ? request.response.statusCode : "<unknown>") + ", " +
            "recv="     + traffic.recvPayload + "/" + traffic.recvRaw + ", " +
            "sent="     + traffic.sentPayload + "/" + traffic.sentRaw + ", " +
            "duration=" + traffic.timeDuration
        log(2, `HAPI: request: ${msg}`)
        latching.hook("hapi:on-response", "none", request)
    })
    server.events.on({ name: "request", channels: [ "error" ] }, (request, event, tags) => {
        if (event.error instanceof Error)
            log(1, `HAPI: request-error: ${event.error.message}`)
        else
            log(1, `HAPI: request-error: ${event.error}`)
        latching.hook("hapi:on-request-error", "none", request)
    })
    server.events.on("log", (event, tags) => {
        if (tags.error) {
            const err = event.error
            if (err instanceof Error)
                log(1, `HAPI: log: ${err.message}`)
            else
                log(1, `HAPI: log: ${err}`)
        }
        latching.hook("hapi:on-log", "none", event, tags)
    })

    /*  register Basic authentication stategy  */
    const requireAuth = (argv.username !== "" && argv.password !== "")
    server.auth.strategy("basic", "basic", {
        validate: async (request, username, password, h) => {
            let isValid     = false
            let credentials = null
            if (username === argv.username && password === argv.password) {
                isValid = true
                credentials = { username }
            }
            const response = { isValid, credentials }
            latching.hook("hapi:validate", "none", response)
            return response
        }
    })

    /*  serve index endpoint  */
    server.route({
        method:   "GET",
        path:     "/",
        options: {
            auth: requireAuth ? { mode: "required", strategy: "basic" } : false
        },
        handler: async (req, h) => {
            let data =
                `<!DOCTYPE html>
                 <html>
                     <head>
                         <title>HUDS</title>
                         <meta charset="utf-8">
                         <meta name="viewport" content="width=device-width, initial-scale=1.0">
                         <link rel="icon" href="data:image/x-icon;base64,AAABAAEAAQEAAAEAGAAsAAAAFgAAACgAAAABAAAAAgAAAAEAGAAAAAAACAAAACgAAAAoAAAAAAAAAAAAAADwgEEAAAAAAA==">
                     </head>
                     <body>
                         <ul>
                         ${Object.keys(HUD).map((name) => {
                             return `<li>HUD <a href="${name}/">${name}</a></li>`
                         }).join("\n")}
                         </ul>
                     </body>
                 </html>`
            data = latching.hook("hapi:serve-index", "pass", data)
            return h.response(data).code(200)
        }
    })

    /*  serve the static HUD files  */
    server.route({
        method:  "GET",
        path:    "/{id}/{file*}",
        options: {
            auth: requireAuth ? { mode: "required", strategy: "basic" } : false
        },
        handler: async (req, h) => {
            const id = req.params.id
            let file = req.params.file
            log(3, `HAPI: receive: remote=${req.info.remoteAddress}, id=${id}, file="${file}"`)
            if (HUD[id] === undefined)
                return h.response().code(404)

            /*  handle special files  */
            if (file === "huds")
                return h.file(path.join(__dirname, "../dst/huds-client.js"), { confine: false })
            if (file === "")
                file = HUD[id].client ? HUD[id].client : "index.html"

            /*  allow hooks to serve file  */
            if (latching.hook("hapi:serve-static", "or", false, req, h, id, file))
                return

            /*  serve file from NPM package or from the HUD directory  */
            let m
            if ((m = file.match(/^@(.+)$/))) {
                file = m[1]

                /*  try to serve file from NPM package, relative to HUD directory
                    (this is the standard case)  */
                /* eslint promise/param-names: off */
                let resolved = await new Promise((provide) => {
                    resolve(file, { basedir: HUD[id].dir }, (err, res) => {
                        if (err) provide(null)
                        else     provide(res)
                    })
                })
                if (resolve === null) {
                    /*  try to serve file from NPM package, relative to HUDS perspective
                        (this is necessary if a HUD is installed with its own dependencies side-by-side)  */
                    try {
                        resolved = require.resolve(file)
                    }
                    catch (err) {
                        resolved = null
                    }
                }
                if (resolved === null)
                    return h.response().code(404)
                const stat = await fs.promises.stat(resolved).catch(() => null)
                if (stat === null)
                    return h.response().code(404)
                if (!stat.isFile())
                    return h.response().code(404)
                return h.file(resolved, { confine: false })
            }
            else {
                /*  serve file from HUD directory  */
                file = path.join(HUD[id].dir, file)
                const stat = await fs.promises.stat(file).catch(() => null)
                if (stat === null)
                    return h.response().code(404)
                if (!stat.isFile())
                    return h.response().code(404)
                return h.file(file, { confine: HUD[id].dir })
            }
        }
    })

    /*  establish MQTT connection  */
    let broker = null
    if (argv.broker !== "" && (argv.topicRecv !== "" || argv.topicSend !== "")) {
        log(2, `connecting to MQTT broker ${argv.broker}`)
        broker = await MQTT.connectAsync(argv.broker, { rejectUnauthorized: false })
        latching.hook("mqtt:broker", "none", broker)
    }

    /*  state store  */
    const peers = {}

    /*  store MQTT send channel as a peer  */
    if (argv.topicSend !== "" && argv.name !== "")
        peers[argv.name] = [ { mqtt: broker } ]

    /*  state fan-out  */
    const fanout = (source, target, event, data) => {
        log(3, `EVENT: emit: source-hud=${source}, target-hud=${target}, event=${event} data=${JSON.stringify(data)}`)
        const object = { id: target, event, data }
        latching.hook("fanout", "none", object, source, target, event, data)
        const message = JSON.stringify(object)
        if (peers[target] !== undefined) {
            peers[target].forEach((peer) => {
                if (peer.ws) {
                    log(3, `WebSocket: send: remote=${peer.req.connection.remoteAddress}, message="${message}"`)
                    peer.ws.send(message)
                }
                else if (peer.mqtt) {
                    log(3, `MQTT: send: remote=${argv.name}, message="${message}"`)
                    peer.mqtt.publish(argv.topicSend, message, { qos: 2 })
                }
            })
        }
    }

    /*  receive messages from MQTT topic  */
    if (argv.broker !== "" && argv.topicRecv !== "") {
        log(2, `subscribing to MQTT receive-topic "${argv.topicRecv}"`)
        await broker.subscribe(argv.topicRecv)
        broker.on("message", (topic, message) => {
            log(3, `MQTT: receive: topic="${topic}" message="${message}"`)
            latching.hook("mqtt:message", "none", topic, message)
            let id, event, data
            try {
                const obj = JSON.parse(message)
                id    = obj.id
                event = obj.event
                data  = obj.data
            }
            catch (ex) {
                return
            }
            if (HUD[id] === undefined)
                return
            const peer = argv.name !== "" ? argv.name : id
            fanout(peer, id, event, data)
        })
    }

    /*  serve client API library  */
    server.route({
        method:   "GET",
        path:     "/{id}/huds",
        options: {
            auth: requireAuth ? { mode: "required", strategy: "basic" } : false,
            cache: { expiresIn: 0, privacy: "private" }
        },
        handler: async (req, h) => {
            const id = req.params.id
            if (HUD[id] === undefined)
                return h.response().code(404)
            const lib = await fs.promises.readFile(path.join(__dirname, "../dst/huds-client.js"), { encoding: "utf8" })
            const cfg = `HUDS.config(${JSON.stringify(HUD[id].data)})`
            let js = `${lib};\n${cfg};\n`
            js = latching.hook("serve-huds", "pass", js, req, h)
            return h.response(js).type("text/javascript").code(200)
        }
    })

    /*  provide exclusive WebSocket route  */
    server.route({
        method:  "POST",
        path:    "/{id}/events",
        options: {
            auth:    requireAuth ? { mode: "required", strategy: "basic" } : false,
            payload: { parse: false },
            plugins: {
                websocket: {
                    only: true,
                    autoping: 30 * 1000,
                    connect: ({ req, ws }) => {
                        const id = req.url.replace(/^\/([^/]+)\/events$/, "$1")
                        if (HUD[id] === undefined) {
                            log(3, `WebSocket: connect: remote=${req.connection.remoteAddress}, hud=${id}, error="invalid-hud-id"`)
                            ws.close(1003, "invalid HUD id")
                        }
                        else {
                            latching.hook("websocket:connect", "none", req, ws, id)
                            if (peers[id] === undefined)
                                peers[id] = []
                            peers[id].push({ req, ws })
                            log(3, `WebSocket: connect: remote=${req.connection.remoteAddress}, hud=${id}`)
                        }
                    },
                    disconnect: ({ req, ws }) => {
                        const id = req.url.replace(/^\/([^/]+)\/events$/, "$1")
                        if (HUD[id] === undefined)
                            log(3, `WebSocket: disconnect: remote=${req.connection.remoteAddress}, hud=${id}, error="invalid-hud-id"`)
                        else {
                            latching.hook("websocket:disconnect", "none", req, ws, id)
                            if (peers[id] !== undefined) {
                                peers[id] = peers[id].filter((x) => x.ws !== ws)
                                if (peers[id].length === 0)
                                    delete peers[id]
                            }
                            log(3, `WebSocket: disconnect: remote=${req.connection.remoteAddress}, hud=${id}`)
                        }
                    }
                }
            }
        },
        handler: (req, h) => {
            /*  treat incoming messages as commands, too  */
            const id = req.params.id
            const message = req.payload.toString()
            latching.hook("websocket:message", "none", req, h, id, message)
            log(3, `WebSocket: receive: remote=${req.info.remoteAddress}, hud=${id}, message=${message}`)
            if (HUD[id] === undefined)
                return h.response("invalid HUD id").code(404)
            let target, event, data
            try {
                const obj = JSON.parse(message)
                target = obj.id
                event  = obj.event
                data   = obj.data
            }
            catch (ex) {
                return h.response("invalid HUD event message").code(400)
            }
            if (HUD[target] === undefined && peers[target] === undefined)
                return h.response("invalid HUD target id").code(404)
            fanout(id, target, event, data)
            return h.response().code(201)
        }
    })

    /*  serve command endpoint  */
    server.route({
        method:   "GET",
        path:     "/{id}/event/{event}",
        options: {
            auth: requireAuth ? { mode: "required", strategy: "basic" } : false
        },
        handler: async (req, h) => {
            const id = req.params.id
            const event = req.params.event
            let data = req.query.data !== undefined ? req.query.data : "null"
            latching.hook("hapi:event", "none", req, h, id, event, data)
            log(3, `HAPI: GET: receive: remote=${req.info.remoteAddress}, hud=${id}, event=${event} data=${data}`)
            if (HUD[id] === undefined)
                return h.response("invalid HUD id").code(404)
            try {
                data = JSON.parse(data)
            }
            catch (ex) {
                return h.response("invalid HUD event data").code(400)
            }
            fanout(id, id, event, data)
            return h.response().code(201)
        }
    })

    /*  serve command endpoint  */
    server.route({
        method:   "POST",
        path:     "/{id}/event/{event}",
        options: {
            auth: requireAuth ? { mode: "required", strategy: "basic" } : false,
            payload: { parse: false }
        },
        handler: async (req, h) => {
            const id = req.params.id
            const event = req.params.event
            let data = req.payload.toString()
            latching.hook("hapi:event", "none", req, h, id, event, data)
            log(3, `HAPI: POST: receive: remote=${req.info.remoteAddress}, hud=${id}, event=${event} data=${data}`)
            if (HUD[id] === undefined)
                return h.response("invalid HUD id").code(404)
            try {
                data = JSON.parse(data)
            }
            catch (ex) {
                return h.response("invalid HUD event data").code(400)
            }
            fanout(id, id, event, data)
            return h.response().code(201)
        }
    })

    /*  start REST server  */
    await server.start()

    /*  graceful termination handling  */
    let terminating = false
    const terminate = async (signal) => {
        if (terminating)
            return
        terminating = true
        log(3, `received ${signal} signal -- shutting down`)
        try {
            for (const id of Object.keys(HUD)) {
                if (HUD[id].plugin !== undefined) {
                    latching.unuse(HUD[id].plugin)
                    delete HUD[id].plugin
                }
            }
        }
        catch (ex) {
            /*  intentionally just ignore  */
        }
        log(3, "stopping HAPI service")
        await server.stop().catch(() => {})
        if (broker !== null) {
            log(3, "stopping MQTT service")
            await broker.end().catch(() => {})
        }
        log(3, "process exit")
        process.exit(0)
    }
    process.on("SIGINT",  () => terminate("INT"))
    process.on("SIGTERM", () => terminate("TERM"))
})().catch((err) => {
    /*  fatal error handling  */
    try {
        for (const id of Object.keys(HUD)) {
            if (HUD[id].plugin !== undefined) {
                latching.unuse(HUD[id].plugin)
                delete HUD[id].plugin
            }
        }
    }
    catch (ex) {
        /*  intentionally just ignore  */
    }
    process.stderr.write(`huds: ERROR: ${err.message}\n`)
    process.exit(1)
})

