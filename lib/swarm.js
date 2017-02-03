const debug = require('debug')('uwt:swarm')
const LRU = require('lru')
const randomIterate = require('random-iterate')

class Swarm {
  constructor (infoHash, server) {
    this.peers = new LRU({
      max: server.peersCacheLength || 1000,
      maxAge: server.peersCacheTtl || 600000 // 600 000ms = 10 minutes
    })

    this.peers.on('evict', data => {
      const peer = data.value
      this._onAnnounceStopped({}, peer, peer.peerId)
    })

    this.complete = 0
    this.incomplete = 0

    this._infoHash = infoHash
    this._server = server
  }

  announce (params, cb) {
    const id = params.peer_id
    // Mark the source peer as recently used in cache
    const peer = this.peers.get(id)

    if (params.event === 'started') {
      this._onAnnounceStarted(params, peer, id)
    } else if (params.event === 'stopped') {
      this._onAnnounceStopped(params, peer, id)
    } else if (params.event === 'completed') {
      this._onAnnounceCompleted(params, peer, id)
    } else if (params.event === 'update') {
      this._onAnnounceUpdate(params, peer, id)
    } else {
      cb(new Error('invalid event'))
      return
    }
    cb(null, {
      complete: this.complete,
      incomplete: this.incomplete,
      peers: this._getPeers(params.numwant, params.peer_id)
    })
  }

  scrape (params, cb) {
    cb(null, {
      complete: this.complete,
      incomplete: this.incomplete
    })
  }

  _onAnnounceStarted (params, peer, id) {
    if (peer) {
      debug('unexpected `started` event from peer that is already in swarm')
      return this._onAnnounceUpdate(params, peer, id) // treat as an update
    }

    if (params.left === 0) this.complete += 1
    else this.incomplete += 1
    peer = this.peers.set(id, {
      complete: params.left === 0,
      peerId: params.peer_id, // as hex
      ip: params.ip,
      port: params.port,
      socket: params.socket
    })
  }

  _onAnnounceStopped (params, peer, id) {
    if (!peer) {
      debug('unexpected `stopped` event from peer that is not in swarm')
      return this._checkEmpty()
    }

    if (peer.complete) this.complete -= 1
    else this.incomplete -= 1

    // Remove this swarm's infohash from the list of active swarms that this peer is participating in.
    if (peer.socket && peer.socket.infoHashes) {
      const index = peer.socket.infoHashes.indexOf(this._infoHash)
      if (index === -1) return debug('Unexpected index of infoHash from peer\'s infoHashes')
      peer.socket.infoHashes.splice(index, 1)

      // If it's not in any other swarms, close the websocket to conserve server resources.
      if (peer.socket.infoHashes.length === 0) {
        process.nextTick(() => {
          peer.socket.close()
          peer.socket = null
        })
      }
    }

    this.peers.remove(id)

    this._checkEmpty()
  }

  _onAnnounceCompleted (params, peer, id) {
    if (!peer) {
      debug('unexpected `completed` event from peer that is not in swarm')
      return this._onAnnounceStarted(params, peer, id) // treat as a start
    }
    if (peer.complete) {
      debug('unexpected `completed` event from peer that is already marked as completed')
      return this._onAnnounceUpdate(params, peer, id) // treat as an update
    }

    this.complete += 1
    this.incomplete -= 1
    peer.complete = true
    this.peers.set(id, peer)
  }

  _onAnnounceUpdate (params, peer, id) {
    if (!peer) {
      debug('unexpected `update` event from peer that is not in swarm')
      return this._onAnnounceStarted(params, peer, id) // treat as a start
    }

    if (!peer.complete && params.left === 0) {
      this.complete += 1
      this.incomplete -= 1
      peer.complete = true
      this.peers.set(id, peer)
    }
  }

  _getPeers (numwant, ownPeerId) {
    const peers = []
    const ite = randomIterate(this.peers.keys)
    let peerId
    while ((peerId = ite()) && peers.length < numwant) {
      // Don't mark the peer as most recently used on announce
      const peer = this.peers.peek(peerId)
      if (!peer) continue
      if (peer.peerId === ownPeerId) continue // don't send peer to itself
      peers.push(peer)
    }
    return peers
  }

  _checkEmpty () {
    if (this.peers.length === 0) {
      this._server.deleteSwarm(this._infoHash)
    }
  }
}

module.exports = Swarm
