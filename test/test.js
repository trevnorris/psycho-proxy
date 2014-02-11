var Proxy = require('../main');
var r = new Proxy(8081);

r.onalert(function(err) {
  process._rawDebug('*** ALERT:');
  process._rawDebug(err.message);
  if (err.data)
    process._rawDebug(err.data.toString());
});

r.onerror(function(err) {
  process._rawDebug('*** ERROR:', err.code);
  process._rawDebug(err.stack);
});

// Test
//r.add('localhost:8081', 80);
// Test wrk (doesn't pass :port for some reason).
r.add('localhost', 8080);

//r.add('localhost:8081', '/tmp/sock.sock');
//r.add('localhost:8081', 9000);
