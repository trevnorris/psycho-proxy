var Pipe = process.binding('pipe_wrap').Pipe;
var TCP = process.binding('tcp_wrap').TCP;
var dns = require('dns');
var path = require('path');
var util = require('util');

// Extending Pipe and TCP a little to keep then monomorphic constructors.

// Attach the server of the incoming connection for future reference.
TCP.prototype._server = undefined;
Pipe.prototype._server = undefined;

// Attach the Proxy instance to the server created on instantiation.
TCP.prototype._proxy = undefined;
Pipe.prototype._proxy = undefined;

// The total number of bytes read from a connection. Used to track if too
// many bytes have been received without finding the Host header.
Pipe.prototype._nread_total = 0;
TCP.prototype._nread_total = 0;

// Stored Buffers of incoming requests so we can concat() the data once
// enough has been collected to read the Host header field.
Pipe.prototype._buffers = undefined;
TCP.prototype._buffers = undefined;

// The return path of a connection when piping data.
Pipe.prototype._return_route = undefined;
TCP.prototype._return_route = undefined;


// Default maximum incoming header size before closing connection is 64KB.
var max_header_length = 64 * 1024;

// TODO(trevnorris): Add check for total number of incoming packet requests
// before closing the connection. Someone could jack the server by sending
// many tiny requests very slowly.

// TODO(trevnorris): Add timeout check for incoming requests. So a single
// connection can't hold open resources without actually using them.

// Export the thing.
module.exports = Proxy;


// A Proxy holds a list of headers and their destinations. When a router
// is instantiated a path or port (pOp) is passed which is where the
// instance will listen for connections.
function Proxy(pOp) {
  if (!(this instanceof Proxy))
    return new Proxy(pOp);

  // Routes that incoming connections must take when they contain a specific
  // Host HTTP header field.
  this._host_routes = {};

  // Both setupTCPServer and setupPipeServer will set the ._handle property.
  if (!isNaN(pOp)) {
    this._pOp = pOp >>> 0;
    setupTCPServer(this, this._pOp);
  } else if (typeof pOp === 'string') {
    this._pOp = path.normalize(pOp);
    setupPipeServer(this, this._pOp);
  } else {
    throw new TypeError('argument must be port or path');
  }

  this._handle.onconnection = onConnection;
  this._handle._proxy = this;
}

Proxy.prototype._handle = undefined;
Proxy.prototype._host_routes = undefined;
Proxy.prototype._onalert = undefined;
Proxy.prototype._onerror = undefined;
Proxy.prototype._pOp = undefined;


// Maximum size in bytes to accept in header before Host: field is found.
// When the maximum length is reached, the connection is immediately
// closed and an alert is issued. Default is 64KB.
Proxy.setMaxHeaderLength = function setMaxHeaderLength(n) {
  max_header_length = n >>> 0;
}


// First argument is the Host HTTP header to be looking for.
// Second argument is the port or path where the data should be piped.
// TODO(trevnorris): Allow adding routes to other host names.
Proxy.prototype.add = function addRoute(host, pOp) {
  pOp = isNaN(pOp) ? path.normalize(pOp) : pOp >>> 0;

  if (!this._host_routes[host])
    this._host_routes[host] = [pOp];
  else if (this._host_routes[host].indexOf(pOp) < 0)
    this._host_routes[host].push(pOp);
};


// Pass a Host header that should no longer be checked, but allows existing
// connections to finish.
Proxy.prototype.close = function closeRoute(host) {
  throw new Error('Closing a route has not been implemented');
};


// Forcefully terminate all connections for a specific Host header.
Proxy.prototype.remove = function removeRoute(host) {
  throw new Error('Removing routes has not been implemented');
};


// setupPipeServer and setupTCPServer are the servers to receive the
// incoming data.

function setupPipeServer(self, path) {
  var socket = new Pipe();
  var err;

  self._handle = socket;

  err = socket.bind(path);
  if (err)
    fail(self, err, 'bind');

  err = socket.listen(511);
  if (err)
    fail(self, err, 'listen');

  return socket;
}


// TODO(trevnorris): Properly support IPv6.
function setupTCPServer(self, port) {
  var server = new TCP();
  var err;

  self._handle = server;

  err = server.bind('127.0.0.1', port);
  if (err)
    fail(self, err, 'bind');

  err = server.listen(511);
  if (err)
    fail(self, err, 'listen');

  return server;
}


// This handles when a connection is received by the listening Proxy.
function onConnection(err, client) {
  if (err)
    fail(this, err, 'connect');

  client._server = this;

  if (client.setKeepAlive) {
    err = client.setKeepAlive(true, 10000);
    if (err)
      fail(this, err, 'keepAlive');
  }

  // First thing we do when a connection is made to the Proxy is verify
  // it is a proper GET or POST. The .onread callback will be reassigned
  // once this is verified.
  client.onread = verifyRequest;

  err = client.readStart();
  if (err)
    fail(this, err, 'read');
}


// Verify early the request is good by checking GET/POST.
function verifyRequest(nread, buffer) {
  if (nread < 0)
    return this.close(onClose);
  if (nread === 0)
    return;

  this._nread_total += nread;

  // First make sure we have at least enough to read the request type.
  if (this._nread_total < 5) {
    if (!this._buffers)
      this._buffers = [buffer];
    else
      this._buffers.push(buffer);
    return;
  }

  // LAZY(trevnorris): The Buffer.concat() thing is me being lazy. Optimize
  // once I have it working properly.
  if (this._buffers) {
    this._buffers.push(buffer);
    buffer = Buffer.concat(this._buffers);
    this._buffers = undefined;
  }

  // LAZY(trevnorris)
  var str = buffer.toString('binary');

  // Initially only supporting GET/POST, if the header does not start
  // with one of these then the client connection will be dropped and
  // and alert() will be broadcast.

  if (str.substr(0, 4) !== 'GET ' && str.substr(0, 5) !== 'POST ') {
    // Bad request, so alert and cleanup connection.
    var err = new Error('Bad HTTP Request');
    // Totally making this up.
    err.code = 'EBADHTTPREQ'
    // Attach the headers we have received so the user can do some logging.
    err.headers = str;
    err.data = buffer;
    alert(this, err);
    this.close(onClose);
    return;
  }

  this.onread = searchHostHeader;
  // Reset to 0 since we're passing the entire concat'd buffer to next
  // callback, which will then properly set it again if the data can't be
  // passed on to the route destination.
  this._nread_total = 0;

  // LAZY(trevnorris): Don't really like that I'm using a .call() here, but
  // was the easiest way to manage this problem.
  searchHostHeader.call(this, buffer.length, buffer);
}


// Check for the Host header.
function searchHostHeader(nread, buffer) {
  if (nread < 0)
    return this.close(onClose);
  if (nread === 0)
    return;

  this._nread_total += nread;

  // LAZY(trevnorris)
  if (this._buffers) {
    this._buffers.push(buffer);
    buffer = Buffer.concat(this._buffers);
    this._buffers = undefined;
  }

  var end_cap = -1;

  // Search for termination.
  // TODO(trevnorris): This only searches for \r\n\r\n, but it's possible
  // to receive malformed data that might look like \n\n. This should
  // probably be supported.
  for (var i = 0; i < buffer.length - 3; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10 &&
        buffer[i + 2] === 13 && buffer[i + 3] === 10) {
      end_cap = i;
      break;
    }
  }

  // Didn't find the end of the request, so wait for more data.
  if (end_cap < 0) {
    // Check if we've read in too much already.
    if (this._nread_total > max_header_length) {
      var err = this.readStop();
      if (err)
        fail(this, err, 'read');
      this.close(onClose);
    }
    this._buffers = [buffer];
    return;
  }

  var host_string;

  // Found the end of the request, so find the host.
  // LAZY(trevnorris)
  var str = buffer.toString();
  var arr = str.split('\r\n');
  // First line should be the request type.
  for (var i = 1; i < arr.length; i++) {
    var idx = arr[i].indexOf(':');
    // This is freakishly lazy of me.
    var field = arr[i].slice(0, idx).trim().toLowerCase();
    if (field === 'host') {
      host_string = arr[i].slice(idx + 1).trim();
      break;
    }
  }

  var routes = this._server._proxy._host_routes[host_string];

  // Check if a route even exists for this host_string.
  if (routes == null) {
    var err = new Error('No known destination for Host: ' + host_string);
    // Making this up.
    err.code = 'ENOROUTE';
    err.host = host_string;
    err.data = buffer;
    alert(this, err);
    this.close(onClose);
    return;
  }

  // We've now verified the request is OK. So make the connection(s) and
  // being piping the data.
  var connection;
  for (var i = 0; i < routes.length; i++) {
    var pOp = routes[i];
    if (isNaN(pOp))
      connection = PipeConnect(this, buffer, pOp);
    else
      connection = TCPConnect(this, buffer, '127.0.0.1', pOp);
  }

  // Attach each connection to each other for quick data piping.
  connection._return_route = this;
  this._return_route = connection;

  // TODO(trevnorris): Store these connections in the Proxy instance so
  // they can be cleaned up when close() and remove() are implemented.

  // Overwrite the .onread method to proxy data directly.
  this.onread = proxyDataToClient;
}


function PipeConnect(self, data, path) {
  var client = new Pipe();
  var req = { oncomplete: afterConnect, _data: data };
  var err = client.connect(req, path);
  if (err)
    fail(self, err, 'connect');
  return client;
}


function TCPConnect(self, data, host, port) {
  var client = new TCP();
  var req = { oncomplete: afterConnect, _data: data };
  var err = client.connect(req, host, port);
  if (err)
    fail(self, err, 'connect');
  return client;
}


function afterConnect(err, client, req, readable, writable) {
  if (err)
    fail(client, err, 'connect');
  client.onread = proxyDataToClient;
  err = client.readStart();
  if (err)
    fail(client, err, 'read');
  if (client.fd <= 0) {
    err = new Error('Attempt to write to bad file descriptor');
    err.code = 'EBADF';
    alert(client, err);
    return;
  }
  err = client.writeBuffer({ oncomplete: dataWritten }, req._data);
  if (err)
    fail(client, err, 'write');
}


function proxyDataToClient(nread, data) {
  if (nread <= 0) {
    if (nread < 0)
      this.close(onClose);
    return;
  }
  if (this._return_route.fd <= 0) {
    err = new Error('Attempt to write to bad file descriptor');
    err.code = 'EBADF';
    alert(client, err);
    return;
  }
  var req = { oncomplete: dataWritten };
  var err = this._return_route.writeBuffer(req, data);
  if (err)
    fail(this, err, 'write');
}


function dataWritten(err, handle, req) {
  if (err)
    fail(this, err, 'write');
  // TODO(trevnorris): Took this straight from core, but do some research
  // why this is necessary.
  if (req && req.cb)
    req.cb.call(handle);
}


function onClose() {
  // TODO(trevnorris): Clean up resources.
}


// Alerts are issues encountered that will not prevent the app
// from functioning, but are still useful for the user to know.
//
// The same callback can only be called once.
//
// fn: Function to be called when an alert is emitted.
// remove: Boolean if the callback should be removed.
Proxy.prototype.onalert = function onAlert(fn, remove) {
  if (typeof fn !== 'function')
    throw new TypeError('argument must be a function');

  if (!this._onalert) {
    if (remove !== true)
      this._onalert = [fn];
    return;
  }

  var idx = this._onalert.indexOf(fn);

  if (remove !== true && idx === -1)
    this._onalert.push(fn);
  else if (remove === true && idx !== -1)
    this._onalert.splice(1, idx);
};


// Alert the user that something has occurred. An Error object is still
// used, but will never be thrown.
function alert(self, err) {
  var callbacks, i;

  err.handle = self;

  // These are all the paths where onalert() callback handlers may be found.
  if (self._onalert)
    callbacks = self._onalert;
  else if (self._proxy && self._proxy._onalert)
    callbacks = self._proxy._onalert;
  else if (self._server &&
           self._server._proxy &&
           self._server._proxy._onalert)
    callbacks = self._server._proxy._onalert;
  else if (self._return_route &&
           self._return_route._server &&
           self._return_route._server._proxy &&
           self._return_route._server._proxy._onalert)
    callbacks = self._return_route._server._proxy._onalert;
  else
    return;

  if (callbacks.length === 0)
    return;

  for (i = 0; i < callbacks.length; i++)
    callbacks[i].call(self, err);
}


// Error handler used when system calls fail. For example, if an attmpt to
// open a remote connection fails.
//
// fn: Function, to be called when an alert is emitted. The same function can
//     only be added once.
// remove: Boolean if the callback should be removed.
Proxy.prototype.onerror = function onError(fn, remove) {
  if (typeof fn !== 'function')
    throw new TypeError('argument must be a function');

  if (!this._onerror) {
    if (remove !== true)
      this._onerror = [fn];
    return;
  }

  var idx = this._onerror.indexOf(fn);

  if (remove !== true && idx === -1)
    this._onerror.push(fn);
  else if (remove === true && idx !== -1)
    this._onerror.splice(1, idx);
};


// Users are allowed to handle their errors by returning "true". If the
// error is handled then it will not be thrown.
//
// Passed Error object has the following properties attached:
//    code: Code of the error
//    errno: Error name
//    handle: Handle of Pipe/TCP connection.
//    syscall: Name of the syscall that failed
//
// All error callbacks will be called, regardless of whether the error has
// already been handled or not. The third argument is whether the error
// was already handled.
function fail(self, err, syscall) {
  var handled = false;
  var callbacks, i;

  err = util._errnoException(err, syscall);
  err.handle = self;

  // These are all the paths where onerror() callback handlers may be found.
  if (self._onerror)
    callbacks = self._onerror;
  else if (self._proxy && self._proxy._onerror)
    callbacks = self._proxy._onerror;
  else if (self._server &&
           self._server._proxy &&
           self._server._proxy._onerror)
    callbacks = self._server._proxy._onerror;
  else if (self._return_route &&
           self._return_route._server &&
           self._return_route._server._proxy &&
           self._return_route._server._proxy._onerror)
    callbacks = self._return_route._server._proxy._onerror;
  else
    throw new Error('No error handlers defined');

  for (i = 0; i < callbacks.length; i++)
    handled = callbacks[i].call(self, err, handled) || handled;

  if (!handled)
    throw err;
}
