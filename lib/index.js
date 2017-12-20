var http = require('http')
var url = require('url')
var path = require('path')
var _ = require('lodash')
var configFactory = require('./config-factory')
var PathRewriter = require('./path-rewriter')
var Router = require('./router')
var logger = require('./logger').getInstance()
var contextMatcher = require('./context-matcher')
var getArrow = require('./logger').getArrow

module.exports = HttpProxyMiddleware

function HttpProxyMiddleware (context, opts) {
  var config = configFactory.createConfig(context, opts)
  var proxyOptions = config.options
  logger.info('[TC] Proxy created:', config.context, ' -> ', proxyOptions.target)

  var pathRewriter = PathRewriter.create(proxyOptions.pathRewrite)

  return middleware

  function middleware (req, res, next) {
    if (!shouldProxy(config.context, req)) {
      next()
    } else {
      var activeProxyOptions = _applyRequestOptions(req, prepareProxyRequest(req))
      var postData = activeProxyOptions['postData'] || ''
      if (postData) delete activeProxyOptions['postData']
      var proxyReq = http.request(activeProxyOptions, function (proxyRes) {
        proxyRes.setEncoding('utf8')
        var content = ''
        proxyRes.on('data', function (chunk) {
          content += chunk
        })
        proxyRes.on('end', function () {
          try {
            JSON.parse(content)
            if (typeof proxyOptions.onProxyRes === 'function') {
              proxyOptions.onProxyRes(proxyRes, req, res)
            }
            res.writeHead(200, {'Content-Type': 'application/json;charset=utf-8'})
            res.end(content)
          } catch (err) {
            logger.error(`[tc] problem with response: ${err.message}`)
            res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'})
            res.end(content)
          }
        })
      })
      proxyReq.on('error', function (e) {
        logger.error(`[tc] problem with request: ${e.message}`)
        res.writeHead(500)
        res.end()
      })
      if(postData) {
        proxyReq.end(postData)
      } else {
        req.pipe(proxyReq)
      }     
    }
  }

  /**
   * Determine whether request should be proxied.
   *
   * @private
   * @param  {String} context [description]
   * @param  {Object} req     [description]
   * @return {Boolean}
   */
  function shouldProxy (context, req) {
    var path = (req.originalUrl || req.url)
    return contextMatcher.match(context, path, req)
  }

  /**
   * Apply option.router and option.pathRewrite
   * Order matters:
   *    Router uses original path for routing
   *    NOT the modified path, after it has been rewritten by pathRewrite
   * @param {Object} req
   * @return {Object} proxy options
   */
  function prepareProxyRequest (req) {
    // https://github.com/chimurai/http-proxy-middleware/issues/17
    // https://github.com/chimurai/http-proxy-middleware/issues/94
    req.url = (req.originalUrl || req.url)

    // store uri before it gets rewritten for logging
    var originalPath = req.url
    var newProxyOptions = _.assign({}, proxyOptions)

    // Apply in order:
    // 1. option.router
    // 2. option.pathRewrite
    __applyRouter(req, newProxyOptions)
    __applyPathRewrite(req, pathRewriter)

    // debug logging for both http(s) and websockets
    if (proxyOptions.logLevel === 'debug') {
      var arrow = getArrow(originalPath, req.url, proxyOptions.target, newProxyOptions.target)
      logger.debug('[HPM] %s %s %s %s', req.method, originalPath, arrow, newProxyOptions.target)
    }

    return newProxyOptions
  }

  // Modify option.target when router present.
  function __applyRouter (req, options) {
    var newTarget

    if (options.router) {
      newTarget = Router.getTarget(req, options)

      if (newTarget) {
        logger.debug('[TC] Router new target: %s -> "%s"', options.target, newTarget)
        options.target = newTarget
      }
    }
  }

  // rewrite path
  function __applyPathRewrite (req, pathRewriter) {
    if (pathRewriter) {
      var path = pathRewriter(req.url, req)

      if (typeof path === 'string') {
        req.url = path
      } else {
        logger.info('[TC] pathRewrite: No rewritten path found. (%s)', req.url)
      }
    }
  }

  function _applyRequestOptions (req, options) {
    var reqOptions = {
      host: url.parse(options.target).host,
      port: options.port | 80,
      method: req.method,
      path: path.join(url.parse(options.target).path, req.url),
      headers: {
        'Content-Type': req.headers['content-type']?req.headers['content-type']:'text/html'
      }
    }
    if (typeof options.onProxyOptions === 'function') {
      options.onProxyOptions(reqOptions, req)
    }
    return reqOptions
  }

  function logError (err, req, res) {
    var hostname = (req.headers && req.headers.host) || (req.hostname || req.host) // (websocket) || (node0.10 || node 4/5)
    var target = proxyOptions.target.host || proxyOptions.target
    var errorMessage = '[TC] Error occurred while trying to proxy request %s from %s to %s (%s) (%s)'
    var errReference = 'https://nodejs.org/api/errors.html#errors_common_system_errors' // link to Node Common Systems Errors page

    logger.error(errorMessage, req.url, hostname, target, err.code, errReference)
  }
}
