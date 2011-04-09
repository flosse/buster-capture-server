var buster = require("buster");
var sinon = require("sinon");

var busterServer = require("./../lib/buster-server");
var clientMiddleware = require("./../lib/capture/client-middleware");

var http = require("http");
var h = require("./test-helper");

buster.testCase("buster-server glue", {
    setUp: function (done) {
        var self = this;
        this.server = Object.create(busterServer);
        this.httpServer = http.createServer(function (req, res) {
            if (!self.server.respond(req, res)) {
                res.writeHead(h.NO_RESPONSE_STATUS_CODE);
                res.end();
            }
        });
        this.httpServer.listen(h.SERVER_PORT, done);
        this.sandbox = sinon.sandbox.create();
    },

    tearDown: function (done) {
        this.httpServer.on("close", done);
        this.httpServer.close();
        this.sandbox.restore();
    },

    "test binds client and session on first request": function (done) {
        var stub = this.sandbox.stub(clientMiddleware, "bindToSessionMiddleware");

        // Performing a request to make the middlewares respond.
        h.request({path: "/doesnotexist", method: "GET"}, function (res, body) {
            buster.assert(stub.calledOnce);
            done();
        }).end();
    },

    "test unknown URL": function (done) {
        h.request({path: "/doesnotexist", method: "GET"}, function (res, body) {
            buster.assert.equals(h.NO_RESPONSE_STATUS_CODE, res.statusCode);
            done();
        }).end();
    }
});