var buster = require("buster");
var assert = buster.assert;
var http = require("http");
var vm = require("vm");
var faye = require("faye");
var busterServer = require("./../lib/buster-server");
var sessionMiddlewareSession = require("./../lib/session/session")

var h = require("./test-helper");

function waitFor(num, callback) {
    var calls = 0;

    return function () {
        calls += 1;

        if (calls == num) {
            callback();
        }
    };
}

buster.testCase("Session middleware", {
    setUp: function (done) {
        var self = this;
        this.httpServer = http.createServer(function (req, res) {
            res.writeHead(h.NO_RESPONSE_STATUS_CODE);
            res.end();
        });
        this.httpServer.listen(h.SERVER_PORT, done);
        this.busterServer = busterServer.create();
        this.busterServer.attach(this.httpServer);
        this.sessionMiddleware = this.busterServer.session;

        this.validSessionPayload = new Buffer(JSON.stringify({
            load: ["/foo.js"],
            resources: {
                "/foo.js": {
                    content: "var a = 5 + 5;"
                }
            }
        }), "utf8");
    },

    tearDown: function (done) {
        this.httpServer.on("close", done);
        this.httpServer.close();
    },

    "test emits event with session info when creating session": function (done) {
        var sessionStart = this.spy();
        this.sessionMiddleware.on("session:start", sessionStart);
        h.request({path: "/sessions", method: "POST"}, function (res, body) {
            assert(sessionStart.calledOnce);
            var sessionInfo = sessionStart.getCall(0).args[0];
            assert.equals("object", typeof(sessionInfo));
            done();
        }).end(this.validSessionPayload);
    },

    "test posting malformed data": function (done) {
        var self = this;
        h.request({path: "/sessions", method: "POST"}, function (res, body) {
            assert.equals(500, res.statusCode);
            assert.match(body, /invalid JSON/i);
            assert.equals(0, self.sessionMiddleware.sessions.length);
            done();
        }).end("{not json}!");
    },

    "test posting with validation error": function (done) {
        var self = this;
        this.stub(sessionMiddlewareSession, "validate");
        sessionMiddlewareSession.validate.returns("An error.");

        h.request({path: "/sessions", method: "POST"}, function (res, body) {
            assert.equals(500, res.statusCode);
            assert.match(body, "An error.");
            assert.equals(0, self.sessionMiddleware.sessions.length);
            done();
        }).end("{}");
    },

    "with HTTP created session": {
        setUp: function (done) {
            var self = this;
            h.request({path: "/sessions", method: "POST"}, function (res, body) {
                self.res = res;
                self.sessionHttpData = JSON.parse(body);
                self.session = self.sessionMiddleware.sessions[0];
                done();
            }).end(this.validSessionPayload);
        },

        "test creating session": function () {
            assert.equals(201, this.res.statusCode);
            assert("location" in this.res.headers);
            assert.match(this.res.headers.location, /^\/.+/);

            assert("rootPath" in this.sessionHttpData);
            assert.equals(this.res.headers.location, this.sessionHttpData.rootPath);

            assert("resourceContextPath" in this.sessionHttpData);
            // resourceContextPath should be prefixed with rootPath.
            var expectedPrefix = this.sessionHttpData.resourceContextPath.slice(0, this.sessionHttpData.rootPath.length)
            assert.equals(expectedPrefix, this.sessionHttpData.rootPath);

            assert("bayeuxClientUrl" in this.sessionHttpData);
            assert("id" in this.sessionHttpData);
            assert.equals(this.sessionHttpData.bayeuxClientUrl, this.busterServer.address + this.sessionHttpData.rootPath + "/messaging");
        },

        "test killing sessions": function (done) {
            var self = this;
            var sessionEnd = this.spy();
            this.sessionMiddleware.on("session:end", sessionEnd);
            h.request({path: this.session.rootPath, method: "DELETE"}, function (res, body) {
                assert.equals(200, res.statusCode);
                assert(sessionEnd.calledOnce);

                h.request({path: self.session.resourceSet.contextPath + "/foo.js", method: "GET"}, function (res, body) {
                    assert.equals(h.NO_RESPONSE_STATUS_CODE, res.statusCode);
                    h.request({path: self.session.rootPath, method: "GET"}, function (res, body) {
                        assert.equals(h.NO_RESPONSE_STATUS_CODE, res.statusCode);
                        done();
                    }).end();
                }).end();
            }).end();
        },

        "test creating session with other session in progress": function (done) {
            h.request({path: "/sessions", method: "POST"}, function (res, body) {
                assert.equals(202, res.statusCode);
                done();
            }).end(new Buffer(JSON.stringify({
                load: [],
                resources: {"/foo.js": {content: "5 + 5;"}}
            }), "utf8"));
        },

        "test killing first session with second session created": function (done) {
            var self = this;
            var sessionStart = this.spy();
            this.sessionMiddleware.on("session:start", sessionStart);
            h.request({path: "/sessions", method: "POST"}, function (res, body) {
                var newSession = JSON.parse(body);
                h.request({path: self.session.rootPath, method: "DELETE"}, function (res, body) {
                    assert(sessionStart.calledOnce);
                    var sessionInfo = sessionStart.getCall(0).args[0];
                    assert.equals(newSession.rootPath, sessionInfo.rootPath);
                    done();
                }).end();
            }).end(this.validSessionPayload);
        },

        "test killing session that isn't current does nothing but deleting the session": function (done) {
            var sessionStart = this.spy();
            this.sessionMiddleware.on("session:start", sessionStart);
            var sessionEnd = this.spy();
            this.sessionMiddleware.on("session:end", sessionEnd);

            h.request({path: "/sessions", method: "POST"}, function (res, body) {
                h.request({path: JSON.parse(body).rootPath, method: "DELETE"}, function () {
                    assert.isFalse(sessionStart.called);
                    assert.isFalse(sessionEnd.called);
                    done();
                }).end();
            }).end(this.validSessionPayload);
        },


        "test loads script middleware scripts before resource scripts": function (done) {
            var self = this;
            h.request({path: this.session.resourceSet.contextPath + "/", method: "GET"}, function (res, body) {
                buster.assert.equals(res.statusCode, 200);
                var scriptTags = body.match(/<script.+>/g);
                assert.match(scriptTags[0], '<script src="' + self.session.resourceSet.contextPath  + require.resolve("buster-core") + '"');
                done();
            }).end();
        },

        "test serves script middleware": function (done) {
            h.request({path: this.session.resourceSet.contextPath  + require.resolve("buster-core"), method: "GET"}, function (res, body) {
                assert.equals(200, res.statusCode);
                done();
            }).end();
        },
    },

    "test programmatically created session is created and loaded": function (done) {
        this.sessionMiddleware.on("session:start", function (session) {
            assert(session.resourceSet.resources.hasOwnProperty("foo"));
            done();
        });

        this.sessionMiddleware.createSession({load:[],resources:{"foo":{content:""}}});
    },

    "test programmatically creating session with none-string or none-buffer as content": function () {
        var self = this;

        assert.exception(function () {
            self.sessionMiddleware.createSession({load:[],resources:{"/foo.js":{content: 123}}});
        });

        assert.exception(function () {
            self.sessionMiddleware.createSession({load:[],resources:{"/foo.js":{content: {}}}});
        });
    },

    "test programmatically created session throws on validation error": function () {
        var self = this;
        assert.exception(function () {
            self.sessionMiddleware.createSession();
        });
    },

    "test programmatically destroying session": function (done) {
        var session = this.sessionMiddleware.createSession({load:[],resources:[]});
        this.sessionMiddleware.destroySession(session.id);

        h.request({path: session.resourceSet.contextPath + "/", method: "GET"}, function (res, body) {
            assert.equals(res.statusCode, h.NO_RESPONSE_STATUS_CODE);
            done();
        }).end();
    },

    "test destroying session in queue with HTTP": function (done) {
        var self = this;

        var spy = this.spy();
        this.sessionMiddleware.on("session:end", spy);

        this.sessionMiddleware.createSession({load:[],resources:[]});
        this.sessionMiddleware.createSession({load:[],resources:[]});
        var session = this.sessionMiddleware.createSession({load:[],resources:[]});

        h.request({path: session.rootPath, method: "DELETE"}, function (res, body) {
            // Callback is only called when current session ends.
            assert.equals(0, spy.callCount);

            assert.equals(2, self.sessionMiddleware.sessions.length);

            var sessionInList = false;
            for (var i = 0, ii = self.sessionMiddleware.sessions.length; i < ii; i++) {
                if (self.sessionMiddleware.sessions[i] == session) sessionInList = true;
            }
            assert.isFalse(sessionInList);

            done();
        }).end();
    },

    "test destroying session in queue programmatically": function () {
        this.sessionMiddleware.createSession({load:[],resources:[]});
        this.sessionMiddleware.createSession({load:[],resources:[]});
        var session = this.sessionMiddleware.createSession({load:[],resources:[]});

        this.sessionMiddleware.destroySession(session.id);

        assert.equals(2, this.sessionMiddleware.sessions.length);

        var sessionInList = false;
        for (var i = 0, ii = this.sessionMiddleware.sessions.length; i < ii; i++) {
            if (this.sessionMiddleware.sessions[i] == session) sessionInList = true;
        }
        assert.isFalse(sessionInList);
    },

    "test creating session with exception from resource system": function (done) {
        var payload = JSON.parse(this.validSessionPayload.toString("utf8"));
        payload.resources["/testtest.js"] = {etag: "an etag that does not exist"};


        h.request({path: "/sessions", method: "POST"}, function (res, body) {
            buster.assert.equals(res.statusCode, 403);
            buster.assert.match(body, "/testtest.js");
            buster.assert.match(body, "an etag that does not exist");
            buster.assert.match(body, "not found");
            done();
        }).end(JSON.stringify(payload));
    },

    "test session does not share messaging with other session": function (done) {
        var sessionA = this.sessionMiddleware.createSession({});
        var sessionB = this.sessionMiddleware.createSession({});

        var fayeA = new Faye.Client(sessionA.bayeuxClientUrl);
        var fayeB = new Faye.Client(sessionB.bayeuxClientUrl);

        assertNotSharedFayeClients(fayeA, fayeB, done);
    },

    "test session does not  share messaging with server": function (done) {
        var session = this.sessionMiddleware.createSession({});
        var faye = new Faye.Client(session.bayeuxClientUrl);
        assertNotSharedFayeClients(faye, this.busterServer.bayeux, done);
    },

    "test sessions has publish and subscribe": function (done) {
        var session = this.sessionMiddleware.createSession({});
        session.subscribe("/foo", function (e) {
            assert.equals(e, "test");
            done();
        }).callback(function () {
            session.publish("/foo", "test");
        });
    }
});

function assertNotSharedFayeClients(fayeA, fayeB, done) {
    var timesCalled = 0;
    var resultHandler = function () {
        if (++timesCalled == 2) {
            // TODO: The process doesn't die properly. Why not?
            fayeA.disconnect();
            fayeB.disconnect();
            done();
        }
    }

    fayeA.subscribe("/foo", function (x) {
        assert.equals(x, "a");
        resultHandler()
    }).callback(function () {
        fayeA.publish("/foo", "a");
        fayeA.publish("/bar", "a");
    });

    fayeB.subscribe("/bar", function (x) {
        assert.equals(x, "b");
        resultHandler()
    }).callback(function () {
        fayeB.publish("/foo", "b");
        fayeB.publish("/bar", "b");
    });
}