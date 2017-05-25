const Buffer = require('safe-buffer').Buffer
const debug = require('debug')('uwt')
const EventEmitter = require('events').EventEmitter
const fs = require('fs')
const http = require('http')
const peerid = require('bittorrent-peerid')
const series = require('run-series')
const WebSocketServer = require('uws').Server

const common = require('./lib/common')
const Swarm = require('./lib/swarm')
const parseWebSocketRequest = require('./lib/parse-websocket')

const NAME = 'µWebTorrentTracker'
const VERSION = require('./package.json').version

/**
 * WebTorrent tracker server.
 *
 * HTTP service which responds to GET requests from torrent clients. Requests include
 * metrics from clients that help the tracker keep overall statistics about the torrent.
 * Responses include a peer list that helps the client participate in the torrent.
 *
 * @param {Object}  opts            options object
 * @param {Number}  opts.interval   tell clients to announce on this interval (ms)
 * @param {Number}  opts.trustProxy trust 'x-forwarded-for' and 'x-real-ip' headers from reverse proxy
 * @param {boolean} opts.stats      enable web-based statistics? (default: true)
 * @param {function} opts.filter    black/whitelist fn for disallowing/allowing torrents
 */
class Server extends EventEmitter {
  constructor (opts) {
    super()
    if (!opts) opts = {}

    debug('new server %o')

    this.intervalMs = opts.interval !== undefined && !isNaN(opts.interval)
      ? opts.interval
      : 2 * 60 * 1000 // 2 min

    this._trustProxy = !!opts.trustProxy
    if (typeof opts.filter === 'function') this._filter = opts.filter

    this.peersCacheLength = opts.peersCacheLength
    this.peersCacheTtl = opts.peersCacheTtl

    this._listenCalled = false
    this.listening = false
    this.destroyed = false
    this.torrents = {}

    this.http = http.createServer()
    this.http.on('error', err => { this._onError(err) })
    this.http.on('listening', () => {
      this.listening = true
      debug('listening')
      this.emit('listening')
    })

    // Add default http request handler on next tick to give user the chance to add
    // their own handler first. Handle requests untouched by user's handler.
    process.nextTick(() => {
      this.http.on('request', (req, res) => {
        if (res.headersSent) return
        // For websocket trackers, we only need to handle the UPGRADE http method.
        // Return 404 for all other request types.
        res.statusCode = 404
        res.end('404 Not Found')
      })
    })

    this.ws = new WebSocketServer({ server: this.http })
    this.ws.on('error', err => { this._onError(err) })
    this.ws.on('connection', socket => { this.onWebSocketConnection(socket) })

    if (opts.stats !== false) {
      this.statsCache = {}
      this.statsHistory = [[], [], [], [], [], [], []]

      this.readStatsHistory()

      // Http handler for '/stats' route
      this.http.on('request', (req, res) => {
        if (res.headersSent) return

        if (req.method === 'GET' && (req.url === '/stats' || req.url === '/stats.json')) {
          const stats = this.getStats()

          if (req.url === '/stats.json' || req.headers['accept'] === 'application/json') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(stats))
          } else if (req.url === '/stats') {
            res.end('<h1>' + stats.torrents + ' active torrents</h1>\n' +
              '<h2>Connected Peers: ' + stats.peersAll + '</h2>\n' +
              '<h3>Peers Seeding Only: ' + stats.peersSeederOnly + '</h3>\n' +
              '<h3>Peers Leeching Only: ' + stats.peersLeecherOnly + '</h3>\n' +
              '<h3>Peers Seeding & Leeching: ' + stats.peersSeederAndLeecher + '</h3>\n' +
              '<h3>IPv4 Peers: ' + stats.peersIPv4 + '</h3>\n' +
              '<h3>IPv6 Peers: ' + stats.peersIPv6 + '</h3>\n' +
              '<h3>Clients:</h3>\n' +
              printClients(stats.clients) +
              '<small>Running <a href="https://www.npmjs.com/package/uwt">' + NAME + '</a> v' + VERSION + '</small>'
            )
          }
        }
      })

      setTimeout(() => { // Start recording stats after 2 minutes (90 seconds timeout + 30 seconds interval)
        setInterval(() => {
          this.recordStats() // Record stats every 30 seconds
        }, 30 * 1000).unref()

        setInterval(() => {
          this.writeStatsHistory()
        }, 60 * 1000).unref() // Write stats history to file every 60 seconds
      }, 90 * 1000).unref()
    }
  }

  _onError (err) {
    this.emit('error', err)
  }

  listen () /* port, onlistening */{
    if (this._listenCalled || this.listening) throw new Error('server already listening')
    this._listenCalled = true

    const lastArg = arguments[arguments.length - 1]
    if (typeof lastArg === 'function') this.once('listening', lastArg)

    const port = toNumber(arguments[0]) || arguments[0] || 0

    debug('listen (port: %o)', port)

    const isObject = obj => {
      return typeof obj === 'object' && obj !== null
    }

    const httpPort = isObject(port) ? (port.http || 0) : port

    if (this.http) this.http.listen(httpPort)
  }

  close (cb) {
    if (!cb) cb = noop
    debug('close')

    this.listening = false
    this.destroyed = true

    if (this.ws) {
      try {
        this.ws.close()
      } catch (err) {}
    }

    if (this.http) this.http.close(cb)
    else cb(null)
  }

  createSwarm (infoHash) {
    if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')

    const swarm = new Swarm(infoHash, this)
    this.torrents[infoHash] = swarm

    return swarm
  }

  deleteSwarm (infoHash) {
    process.nextTick(() => {
      delete this.torrents[infoHash]
    })
  }

  getSwarm (infoHash) {
    if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')

    return this.torrents[infoHash]
  }

  onWebSocketConnection (socket, opts) {
    if (!opts) opts = {}
    opts.trustProxy = opts.trustProxy || this._trustProxy

    socket.headers = socket.upgradeReq.headers
    socket.realIPAddress = opts.trustProxy ? socket.headers['x-forwarded-for'] || socket._socket.remoteAddress : socket._socket.remoteAddress.replace(common.REMOVE_IPV4_MAPPED_IPV6_RE, '') // force ipv4
    socket.port = socket._socket.remotePort

    socket.peerId = null // as hex
    socket.infoHashes = [] // swarms that this socket is participating in
    socket.onSend = err => {
      this._onWebSocketSend(socket, err)
    }

    socket.onMessageBound = params => {
      this._onWebSocketRequest(socket, opts, params)
    }
    socket.on('message', socket.onMessageBound)

    socket.onErrorBound = err => {
      this._onWebSocketError(socket, err)
    }
    socket.on('error', socket.onErrorBound)

    socket.onCloseBound = () => {
      this._onWebSocketClose(socket)
    }
    socket.on('close', socket.onCloseBound)
  }

  getStats () {
    if (this.statsCache.lastUpdated !== undefined && Date.now() < this.statsCache.lastUpdated + 10 * 1000) {
      return this.statsCache.value
    }

    const infoHashes = Object.keys(this.torrents)
    const allPeers = {}

    infoHashes.forEach(infoHash => {
      const peers = this.torrents[infoHash].peers
      const keys = peers.keys

      keys.forEach(peerId => {
        // Don't mark the peer as most recently used for stats
        const peer = peers.peek(peerId)
        if (peer === null) return // peers.peek() can evict the peer

        if (!allPeers[peerId]) {
          allPeers[peerId] = {
            ipv4: false,
            ipv6: false,
            seeder: false,
            leecher: false
          }
        }

        if (peer.ip.indexOf(':') >= 0) {
          allPeers[peerId].ipv6 = true
        } else {
          allPeers[peerId].ipv4 = true
        }

        if (peer.complete) {
          allPeers[peerId].seeder = true
        } else {
          allPeers[peerId].leecher = true
        }

        allPeers[peerId].peerId = peer.peerId
        allPeers[peerId].client = peerid(peer.peerId)
      })
    })

    const stats = {
      torrents: infoHashes.length,
      peersAll: Object.keys(allPeers).length,
      peersSeederOnly: countPeers(isSeederOnly, allPeers),
      peersLeecherOnly: countPeers(isLeecherOnly, allPeers),
      peersSeederAndLeecher: countPeers(isSeederAndLeecher, allPeers),
      peersIPv4: countPeers(isIPv4, allPeers),
      peersIPv6: countPeers(isIPv6, allPeers),
      clients: groupByClient(allPeers),
      server: NAME,
      serverVersion: VERSION
    }

    this.statsCache.value = stats
    this.statsCache.lastUpdated = Date.now()

    return stats
  }

  recordStats () {
    const stats = Object.values(this.getStats())
    const date = new Date()

    for (let i = 0; i < 7; i++) {
      this.statsHistory[0].push({date: date, value: stats[0]})
    }
  }

  readStatsHistory () {
    fs.readFile('./statsHistory.json', (err, history) => {
      if (err) return debug(err)
      this.statsHistory = JSON.parse(history)
    })
  }

  writeStatsHistory () {
    fs.writeFile('./statsHistory.json', JSON.stringify(this.statsHistory), (err) => {
      if (err) return debug(err)
    })
  }

  _onWebSocketRequest (socket, opts, params) {
    try {
      params = parseWebSocketRequest(socket, opts, params)
    } catch (err) {
      socket.send(JSON.stringify({
        'failure reason': err.message
      }), socket.onSend)

      // even though it's an error for the client, it's just a warning for the server.
      // don't crash the server because a client sent bad data :)
      this.emit('warning', err)
      return
    }

    if (!socket.peerId) socket.peerId = params.peer_id // as hex

    this._onRequest(params, (err, response) => {
      if (this.destroyed) return
      if (err) {
        socket.send(JSON.stringify({
          action: params.action === common.ACTIONS.ANNOUNCE ? 'announce' : 'scrape',
          'failure reason': err.message,
          info_hash: common.hexToBinary(params.info_hash)
        }), socket.onSend)

        this.emit('warning', err)
        return
      }

      response.action = params.action === common.ACTIONS.ANNOUNCE ? 'announce' : 'scrape'

      let peers
      if (response.action === 'announce') {
        peers = response.peers
        delete response.peers

        if (socket.infoHashes.indexOf(params.info_hash) === -1) {
          socket.infoHashes.push(params.info_hash)
        }

        response.info_hash = common.hexToBinary(params.info_hash)
      }

      // Skip sending update back for 'answer' announce messages – not needed
      if (!params.answer) {
        socket.send(JSON.stringify(response), socket.onSend)
        debug('sent response %s to %s', JSON.stringify(response), params.peer_id)
      }

      if (Array.isArray(params.offers)) {
        debug('got %s offers from %s', params.offers.length, params.peer_id)
        debug('got %s peers from swarm %s', peers.length, params.info_hash)
        peers.forEach((peer, i) => {
          peer.socket.send(JSON.stringify({
            action: 'announce',
            offer: params.offers[i].offer,
            offer_id: params.offers[i].offer_id,
            peer_id: common.hexToBinary(params.peer_id),
            info_hash: common.hexToBinary(params.info_hash)
          }), peer.socket.onSend)
          debug('sent offer to %s from %s', peer.peerId, params.peer_id)
        })
      }

      const done = () => {
        // emit event once the announce is fully "processed"
        if (params.action === common.ACTIONS.ANNOUNCE) {
          this.emit(common.EVENT_NAMES[params.event], params.peer_id, params)
        }
      }

      if (params.answer) {
        debug('got answer %s from %s', JSON.stringify(params.answer), params.peer_id)

        const swarm = this.getSwarm(params.info_hash)

        if (!swarm) {
          return this.emit('warning', new Error('no swarm with that `info_hash`'))
        }
        // Mark the destination peer as recently used in cache
        const toPeer = swarm.peers.get(params.to_peer_id)
        if (!toPeer) {
          return this.emit('warning', new Error('no peer with that `to_peer_id`'))
        }

        toPeer.socket.send(JSON.stringify({
          action: 'announce',
          answer: params.answer,
          offer_id: params.offer_id,
          peer_id: common.hexToBinary(params.peer_id),
          info_hash: common.hexToBinary(params.info_hash)
        }), toPeer.socket.onSend)
        debug('sent answer to %s from %s', toPeer.peerId, params.peer_id)

        done()
      } else {
        done()
      }
    })
  }

  _onWebSocketSend (socket, err) {
    if (err) this._onWebSocketError(socket, err)
  }

  _onWebSocketClose (socket) {
    debug('websocket close %s', socket.peerId)

    if (socket.peerId) {
      socket.infoHashes.slice(0).forEach(infoHash => {
        const swarm = this.torrents[infoHash]
        if (swarm) {
          swarm.announce({
            event: 'stopped',
            numwant: 0,
            peer_id: socket.peerId
          }, noop)
        }
      })
    }

    // ignore all future errors
    socket.onSend = noop
    socket.on('error', noop)

    if (typeof socket.onMessageBound === 'function') {
      socket.removeListener('message', socket.onMessageBound)
    }
    socket.onMessageBound = null

    if (typeof socket.onErrorBound === 'function') {
      socket.removeListener('error', socket.onErrorBound)
    }
    socket.onErrorBound = null

    if (typeof socket.onCloseBound === 'function') {
      socket.removeListener('close', socket.onCloseBound)
    }
    socket.onCloseBound = null

    socket.peerId = null
    socket.infoHashes = null
  }

  _onWebSocketError (socket, err) {
    debug('websocket error %s', err.message || err)
    this.emit('warning', err)
    this._onWebSocketClose(socket)
  }

  _onRequest (params, cb) {
    if (params && params.action === common.ACTIONS.CONNECT) {
      cb(null, { action: common.ACTIONS.CONNECT })
    } else if (params && params.action === common.ACTIONS.ANNOUNCE) {
      this._onAnnounce(params, cb)
    } else if (params && params.action === common.ACTIONS.SCRAPE) {
      this._onScrape(params, cb)
    } else {
      cb(new Error('Invalid action'))
    }
  }

  _onAnnounce (params, cb) {
    const createSwarm = () => {
      const swarm = this.createSwarm(params.info_hash)
      announce(swarm)
    }

    const createSwarmFilter = () => {
      if (this._filter) {
        this._filter(params.info_hash, params, err => {
          if (err) {
            cb(err)
          } else {
            createSwarm()
          }
        })
      } else {
        createSwarm()
      }
    }

    const announce = (swarm) => {
      if (!params.event || params.event === 'empty') params.event = 'update'
      swarm.announce(params, (err, response) => {
        if (err) return cb(err)

        if (!response.action) response.action = common.ACTIONS.ANNOUNCE
        if (!response.interval) response.interval = Math.ceil(this.intervalMs / 1000)

        cb(null, response)
      })
    }

    const swarm = this.getSwarm(params.info_hash)

    if (swarm) {
      announce(swarm)
    } else {
      createSwarmFilter()
    }
  }

  _onScrape (params, cb) {
    if (params.info_hash === null) {
      // if info_hash param is omitted, stats for all torrents are returned
      params.info_hash = Object.keys(this.torrents)
    }

    series(params.info_hash.map(infoHash => cb => {
      const swarm = this.getSwarm(infoHash)

      if (swarm) {
        swarm.scrape(params, (err, scrapeInfo) => {
          if (err) return cb(err)
          cb(null, {
            infoHash: infoHash,
            complete: (scrapeInfo && scrapeInfo.complete) || 0,
            incomplete: (scrapeInfo && scrapeInfo.incomplete) || 0
          })
        })
      } else {
        cb(null, { infoHash: infoHash, complete: 0, incomplete: 0 })
      }
    }), (err, results) => {
      if (err) return cb(err)

      const response = {
        action: common.ACTIONS.SCRAPE,
        files: {},
        flags: { min_request_interval: Math.ceil(this.intervalMs / 1000) }
      }

      results.forEach(result => {
        response.files[common.hexToBinary(result.infoHash)] = {
          complete: result.complete || 0,
          incomplete: result.incomplete || 0,
          downloaded: result.complete || 0
        }
      })

      cb(null, response)
    })
  }
}

function countPeers (filterFunction, allPeers) {
  let count = 0
  let key

  for (key in allPeers) {
    if (allPeers.hasOwnProperty(key) && filterFunction(allPeers[key])) {
      count++
    }
  }

  return count
}

function groupByClient (allPeers) {
  const clients = {}
  for (const key in allPeers) {
    if (allPeers.hasOwnProperty(key)) {
      const peer = allPeers[key]

      if (!clients[peer.client.client]) {
        clients[peer.client.client] = {}
      }
      const client = clients[peer.client.client]
      // If the client is not known show 8 chars from peerId as version
      const version = peer.client.version || new Buffer(peer.peerId, 'hex').toString().substring(0, 8)
      if (!client[version]) {
        client[version] = 0
      }
      client[version]++
    }
  }
  return clients
}

function printClients (clients) {
  let html = '<ul>\n'
  for (const name in clients) {
    if (clients.hasOwnProperty(name)) {
      const client = clients[name]
      for (const version in client) {
        if (client.hasOwnProperty(version)) {
          html += '<li><strong>' + name + '</strong> ' + version + ' : ' + client[version] + '</li>\n'
        }
      }
    }
  }
  html += '</ul>\n'
  return html
}

function isSeederOnly (peer) { return peer.seeder && peer.leecher === false }

function isLeecherOnly (peer) { return peer.leecher && peer.seeder === false }

function isSeederAndLeecher (peer) { return peer.seeder && peer.leecher }

function isIPv4 (peer) { return peer.ipv4 }

function isIPv6 (peer) { return peer.ipv6 }

function toNumber (x) {
  x = Number(x)
  return x >= 0 ? x : false
}

function noop () {}

module.exports = Server
