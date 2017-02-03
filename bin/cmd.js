#!/usr/bin/env node

const minimist = require('minimist')
const Server = require('../')

const argv = minimist(process.argv.slice(2), {
  alias: {
    h: 'help',
    p: 'port',
    q: 'quiet',
    s: 'silent',
    v: 'version'
  },
  boolean: [
    'help',
    'quiet',
    'silent',
    'trust-proxy',
    'version',
    'stats'
  ],
  default: {
    port: 8000,
    stats: true
  }
})

if (argv.version) {
  console.log(require('../package.json').version)
  process.exit(0)
}

if (argv.help) {
  console.log((() => {
  /*
  webtorrent-tracker - Start a webtorrent tracker server

  Usage:
    webtorrent-tracker [OPTIONS]

  Options:
    -p, --port [number]           change the port [default: 8000]
        --trust-proxy             trust 'x-forwarded-for' header from reverse proxy
        --interval                client announce interval (ms) [default: 120000]
        --stats                   enable web-based statistics (default: true)
    -q, --quiet                   only show error output
    -s, --silent                  show no output
    -v, --version                 print the current version

  Please report bugs!  https://github.com/DiegoRBaquero/uwt/issues

  */
  }).toString().split(/\n/).slice(2, -2).join('\n'))
  process.exit(0)
}

if (argv.silent) argv.quiet = true

const server = new Server({
  interval: argv.interval,
  stats: argv.stats,
  trustProxy: argv['trust-proxy']
})

server.on('error', err => {
  if (!argv.silent) console.error('ERROR: ' + err.message)
})
server.on('warning', err => {
  if (!argv.quiet) console.log('WARNING: ' + err.message)
})
server.on('update', addr => {
  if (!argv.quiet) console.log('update: ' + addr)
})
server.on('complete', addr => {
  if (!argv.quiet) console.log('complete: ' + addr)
})
server.on('start', addr => {
  if (!argv.quiet) console.log('start: ' + addr)
})
server.on('stop', addr => {
  if (!argv.quiet) console.log('stop: ' + addr)
})

server.listen(argv.port, () => {
  if (server.ws && !argv.quiet) {
    const wsAddr = server.http.address()
    const wsHost = wsAddr.address !== '::' ? wsAddr.address : 'localhost'
    const wsPort = wsAddr.port
    console.log('Tracker: ws://' + wsHost + ':' + wsPort)
  }
  if (server.http && argv.stats && !argv.quiet) {
    const statsAddr = server.http.address()
    const statsHost = statsAddr.address !== '::' ? statsAddr.address : 'localhost'
    const statsPort = statsAddr.port
    console.log('Tracker stats: http://' + statsHost + ':' + statsPort + '/stats')
  }
})
