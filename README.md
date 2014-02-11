# psycho-proxy

Because you'd have to be nuts to use this.

It's a little experiment I did to see how quickly Node could proxy data when
all the fluff layers are removed.

**Warning**: This only works with, I think, v0.11.5 and above.

## API

Here's a basic overview of this very basic API. First, though, here's some
basic usage:

```javascript
var Proxy = require('psycho-proxy');
// Pass the listening port on instantiation.
var p = new Proxy(8081);

p.onalert(function(err) {
  // Alerts are things that are nice to know,
  // but won't break the world.
});

p.onerror(function(err) {
  // These could cause your application to crash,
  // but if handled return "true" to continue normally.
});

// First pass the expected Host then where it should go.
p.add('localhost:8081', 8080);
```

### Proxy(pOp)

Create a new `Proxy` instance, passing in the port or path (`pOp`). This is
a custom object built on top of Node internals. So don't expect a Stream
back or anything.

### Proxy.setMaxHeaderLength(n)

* n `Number`: Number of bytes to inspect.

Set how much data to read, looking for the Host header, before the connection
is closed. This is to prevent flooding.

### Proxy#add(host, pOp)

* host `String`: Expected Host header.
* pOp `Number`|`String`: Port or path to proxy data.

### Proxy#onalert(callback[, remove])

* callback `Function`: Callback called when an alert is issued. The same
callback can be added only once.
* remove `Boolean`: Pass true if you wish to remove the given callback.

The `onalert()` callback will receive an `Error` instance as its only
argument. The following additional properties may be set on this object:

* handle `Object`: The object instance on which the alert occurred.
* code `String`: The alert code for what happened (I made up some of these).
* data `Buffer`: All the data that has been collected by the given connection.
* host `String`: The Host field that was parsed from the request.

### Proxy#onerror(callback[, remove])

* callback `Function`: Callback called when an error is issued. The same
callback can be added only once. User can optionally return `true` if the
error has been handled.
* remove `Boolean`: Pass true if you wish to remove the given callback.

Errors from Proxy are when something out of the control of Proxy has happened.
For example, if an incoming request needs to connect to a remote location
and was unable to do so. If the user can recover from any of these errors
then simply return `true` from the callback and execution will continue as
normal (at least in theory).

The `Error` object passed to the `onerror()` callback will have the following
additional property set:

* handle `Object`: The object instance on which the error occurred.


## TBD (to be done)

Currently there isn't proper support for IPv6, and several other methods are
missing. Like the ability to close specific connections based on user
specified criterion.
