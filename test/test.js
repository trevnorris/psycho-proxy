var Proxy = require('../main');
var r = new Proxy(8081);

r.onalert(function(err) {
  process._rawDebug('*** ALERT:');
  process._rawDebug(err);
  process._rawDebug(err.data.toString());
  process.exit();
});

r.onerror(function() {
  process._rawDebug('*** ERROR:', arguments);
});

// Test
r.add('localhost:8081', 80);
// Test wrk (doesn't pass :port for some reason).
//r.add('localhost', 80);

//r.add('localhost:8081', '/tmp/sock.sock');
//r.add('localhost:8081', 9000);
