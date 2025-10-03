//
// Copyright (c) 2013-2025 Winlin
//
// SPDX-License-Identifier: MIT
//

'use strict';

function SrsError(name, message) {
    this.name = name;
    this.message = message;
    this.stack = (new Error()).stack;
}
SrsError.prototype = Object.create(Error.prototype);
SrsError.prototype.constructor = SrsError;

// Depends on adapter-7.4.0.min.js from https://github.com/webrtc/adapter
// Async-awat-prmise based SRS RTC Publisher.
function SrsRtcPublisherAsync() {
    var self = {};

    // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
    self.constraints = {
        audio: true,
        video: {
            width: {ideal: 320, max: 576}
        }
    };

    self.publish = async function (url) {
        var conf = self.__internal.prepareUrl(url);
        self.pc.addTransceiver("audio", {direction: "sendonly"});
        self.pc.addTransceiver("video", {direction: "sendonly"});

        if (!navigator.mediaDevices && window.location.protocol === 'http:' && window.location.hostname !== 'localhost') {
            throw new SrsError('HttpsRequiredError', `Please use HTTPS or localhost to publish, read https://github.com/ossrs/srs/issues/2762#issuecomment-983147576`);
        }
        var stream = await navigator.mediaDevices.getUserMedia(self.constraints);

        // @see https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/addStream#Migrating_to_addTrack
        stream.getTracks().forEach(function (track) {
            self.pc.addTrack(track);

            // Notify about local track when stream is ok.
            self.ontrack && self.ontrack({track: track});
        });

        var offer = await self.pc.createOffer();
        await self.pc.setLocalDescription(offer);
        var session = await new Promise(function (resolve, reject) {
            // @see https://github.com/rtcdn/rtcdn-draft
            var data = {
                api: conf.apiUrl, tid: conf.tid, streamurl: conf.streamUrl,
                clientip: null, sdp: offer.sdp
            };
            console.log("Generated offer: ", data);

            const xhr = new XMLHttpRequest();
            xhr.onload = function() {
                if (xhr.readyState !== xhr.DONE) return;
                if (xhr.status !== 200 && xhr.status !== 201) return reject(xhr);
                const data = JSON.parse(xhr.responseText);
                console.log("Got answer: ", data);
                return data.code ? reject(xhr) : resolve(data);
            }
            xhr.open('POST', conf.apiUrl, true);
            xhr.setRequestHeader('Content-type', 'application/json');
            xhr.send(JSON.stringify(data));
        });
        await self.pc.setRemoteDescription(
            new RTCSessionDescription({type: 'answer', sdp: session.sdp})
        );
        session.simulator = conf.schema + '//' + conf.urlObject.server + ':' + conf.port + '/rtc/v1/nack/';

        return session;
    };

    // Close the publisher.
    self.close = function () {
        self.pc && self.pc.close();
        self.pc = null;
    };

    // The callback when got local stream.
    self.ontrack = function (event) {
        // Add track to stream of SDK.
        self.stream.addTrack(event.track);
    };

    // Internal APIs.
    self.__internal = {
        defaultPath: '/rtc/v1/publish/',
        prepareUrl: function (webrtcUrl) {
            var urlObject = self.__internal.parse(webrtcUrl);

            // If user specifies the schema, use it as API schema.
            var schema = urlObject.user_query.schema;
            schema = schema ? schema + ':' : window.location.protocol;

            var port = urlObject.port || 1985;
            if (schema === 'https:') {
                port = urlObject.port || 8443;
            }

            // @see https://github.com/rtcdn/rtcdn-draft
            var api = urlObject.user_query.play || self.__internal.defaultPath;
            if (api.lastIndexOf('/') !== api.length - 1) {
                api += '/';
            }

            var apiUrl = schema + '//' + urlObject.server + ':' + port + api;
            for (var key in urlObject.user_query) {
                if (key !== 'api' && key !== 'play') {
                    apiUrl += '&' + key + '=' + urlObject.user_query[key];
                }
            }
            // Replace /rtc/v1/play/&k=v to /rtc/v1/play/?k=v
            apiUrl = apiUrl.replace(api + '&', api + '?');

            var streamUrl = urlObject.url;

            return {
                apiUrl: apiUrl, streamUrl: streamUrl, schema: schema, urlObject: urlObject, port: port,
                tid: Number(parseInt(new Date().getTime()*Math.random()*100)).toString(16).slice(0, 7)
            };
        },
        parse: function (url) {
            var a = document.createElement("a");
            a.href = url.replace("rtmp://", "http://")
                .replace("webrtc://", "http://")
                .replace("rtc://", "http://");

            var vhost = a.hostname;
            var app = a.pathname.substring(1, a.pathname.lastIndexOf("/"));
            var stream = a.pathname.slice(a.pathname.lastIndexOf("/") + 1);

            // parse the vhost in the params of app, that srs supports.
            app = app.replace("...vhost...", "?vhost=");
            if (app.indexOf("?") >= 0) {
                var params = app.slice(app.indexOf("?"));
                app = app.slice(0, app.indexOf("?"));

                if (params.indexOf("vhost=") > 0) {
                    vhost = params.slice(params.indexOf("vhost=") + "vhost=".length);
                    if (vhost.indexOf("&") > 0) {
                        vhost = vhost.slice(0, vhost.indexOf("&"));
                    }
                }
            }

            // when vhost equals to server, and server is ip,
            // the vhost is __defaultVhost__
            if (a.hostname === vhost) {
                var re = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
                if (re.test(a.hostname)) {
                    vhost = "__defaultVhost__";
                }
            }

            // parse the schema
            var schema = "rtmp";
            if (url.indexOf("://") > 0) {
                schema = url.slice(0, url.indexOf("://"));
            }

            var port = a.port;
            if (!port) {
                if (schema === 'webrtc' && url.indexOf(`webrtc://${a.host}:`) === 0) {
                    port = (url.indexOf(`webrtc://${a.host}:80`) === 0) ? 80 : 8443;
                }

                if (schema === 'http') {
                    port = 80;
                } else if (schema === 'https') {
                    port = 8443;
                } else if (schema === 'rtmp') {
                    port = 1935;
                }
            }

            var ret = {
                url: url,
                schema: schema,
                server: a.hostname, port: port,
                vhost: vhost, app: app, stream: stream
            };
            self.__internal.fill_query(a.search, ret);

            if (!ret.port) {
                if (schema === 'webrtc' || schema === 'rtc') {
                    if (ret.user_query.schema === 'https') {
                        ret.port = 8443;
                    } else if (window.location.href.indexOf('https://') === 0) {
                        ret.port = 8443;
                    } else {
                        ret.port = 1985;
                    }
                }
            }

            return ret;
        },
        fill_query: function (query_string, obj) {
            obj.user_query = {};

            if (query_string.length === 0) {
                return;
            }
            if (query_string.indexOf("?") >= 0) {
                query_string = query_string.split("?")[1];
            }

            var queries = query_string.split("&");
            for (var i = 0; i < queries.length; i++) {
                var elem = queries[i];

                var query = elem.split("=");
                obj[query[0]] = query[1];
                obj.user_query[query[0]] = query[1];
            }

            if (obj.domain) {
                obj.vhost = obj.domain;
            }
        }
    };

    self.pc = new RTCPeerConnection(null);

    // To keep api consistent between player and publisher.
    self.stream = new MediaStream();

    return self;
}

// Depends on adapter-7.4.0.min.js from https://github.com/webrtc/adapter
// Async-await-promise based SRS RTC Player.
function SrsRtcPlayerAsync() {
    var self = {};

    // Helpers for auto-adaptation.
    function str2bool(v, dft) {
        if (v === undefined) return dft;
        v = ('' + v).toLowerCase();
        return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
    }
    function detectKindsFromSdp(sdp) {
        const hasAudio = /(^|\r\n)m=audio\s/i.test(sdp);
        const hasVideo = /(^|\r\n)m=video\s/i.test(sdp);
        return {audio: !!hasAudio, video: !!hasVideo};
    }
    async function postPlayOffer(conf, sdp) {
        return await new Promise(function(resolve, reject) {
            var data = {
                api: conf.apiUrl, tid: conf.tid, streamurl: conf.streamUrl,
                clientip: null, sdp: sdp
            };
            console.log("Generated offer: ", data);

            const xhr = new XMLHttpRequest();
            xhr.onload = function() {
                if (xhr.readyState !== xhr.DONE) return;
                if (xhr.status !== 200 && xhr.status !== 201) return reject(xhr);
                const data = JSON.parse(xhr.responseText);
                console.log("Got answer: ", data);
                return data.code ? reject(xhr) : resolve(data);
            }
            xhr.open('POST', conf.apiUrl, true);
            xhr.setRequestHeader('Content-type', 'application/json');
            xhr.send(JSON.stringify(data));
        });
    }
    function setupPcRecvOnly(audio, video) {
        // Close old pc before creating a new one for a clean SDP.
        if (self.pc) { try { self.pc.close(); } catch (e) {} }
        self.pc = new RTCPeerConnection(null);

        // Keep remote tracks aggregated into self.stream.
        self.pc.ontrack = function(event) {
            self.stream.addTrack(event.track);
            if (self.ontrack) self.ontrack(event);
        };

        if (audio) self.pc.addTransceiver("audio", {direction: "recvonly"});
        if (video) self.pc.addTransceiver("video", {direction: "recvonly"});
    }

    // @url webrtc://... or with overrides: ?audio=0&video=1
    self.play = async function(url) {
        var conf = self.__internal.prepareUrl(url);

        // Read user preference from query. Default: both enabled.
        const uq = conf.urlObject.user_query || {};
        let wantAudio = str2bool(uq.audio, true);
        let wantVideo = str2bool(uq.video, true);
        const forced = (uq.audio !== undefined) || (uq.video !== undefined);

        if (!wantAudio && !wantVideo) {
            throw new SrsError('ParamError', 'Both audio and video are disabled (audio=0&video=0).');
        }

        // First attempt with user preference (or both if not forced).
        setupPcRecvOnly(wantAudio, wantVideo);
        let offer = await self.pc.createOffer();
        await self.pc.setLocalDescription(offer);

        let session;
        try {
            session = await postPlayOffer(conf, offer.sdp);
        } catch (e) {
            // Network/API error.
            throw e;
        }

        // Before setRemoteDescription, check if m-lines are compatible.
        const remoteKinds = detectKindsFromSdp(session.sdp);
        const localKinds = {audio: wantAudio, video: wantVideo};
        const localCount = (localKinds.audio?1:0) + (localKinds.video?1:0);
        const remoteCount = (remoteKinds.audio?1:0) + (remoteKinds.video?1:0);
        const kindsMismatch = (localCount !== remoteCount) ||
                              (localKinds.audio && !remoteKinds.audio) ||
                              (localKinds.video && !remoteKinds.video);

        if (kindsMismatch && !forced) {
            console.warn('[SRS][Player] SDP kinds mismatch, auto-retry with remote kinds:', remoteKinds);
            // Retry with exactly what server will send.
            if (!remoteKinds.audio && !remoteKinds.video) {
                // Server answer abnormal, try fallback: video-only then audio-only.
                setupPcRecvOnly(false, true);
                offer = await self.pc.createOffer();
                await self.pc.setLocalDescription(offer);
                try {
                    session = await postPlayOffer(conf, offer.sdp);
                    await self.pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: session.sdp}));
                } catch (e2) {
                    setupPcRecvOnly(true, false);
                    offer = await self.pc.createOffer();
                    await self.pc.setLocalDescription(offer);
                    session = await postPlayOffer(conf, offer.sdp);
                    await self.pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: session.sdp}));
                }
            } else {
                setupPcRecvOnly(remoteKinds.audio, remoteKinds.video);
                offer = await self.pc.createOffer();
                await self.pc.setLocalDescription(offer);
                session = await postPlayOffer(conf, offer.sdp);
                await self.pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: session.sdp}));
            }
        } else {
            // Try normal path.
            try {
                await self.pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: session.sdp}));
            } catch (err) {
                // If still fails due to m-line order, try auto-fallback once (only when not forced).
                if (!forced && (err.name === 'InvalidAccessError' || /m-lines|order.*m-lines/i.test(err.message||''))) {
                    console.warn('[SRS][Player] setRemoteDescription failed, auto-fallback with remote kinds:', remoteKinds, err);
                    setupPcRecvOnly(remoteKinds.audio, remoteKinds.video);
                    offer = await self.pc.createOffer();
                    await self.pc.setLocalDescription(offer);
                    session = await postPlayOffer(conf, offer.sdp);
                    await self.pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: session.sdp}));
                } else {
                    throw err;
                }
            }
        }

        session.simulator = conf.schema + '//' + conf.urlObject.server + ':' + conf.port + '/rtc/v1/nack/';
        return session;
    };

    // Close the player.
    self.close = function() {
        self.pc && self.pc.close();
        self.pc = null;
    };

    // The callback when got remote track.
    self.ontrack = function (event) {
        self.stream.addTrack(event.track);
    };

    // Internal APIs.
    self.__internal = {
        defaultPath: '/rtc/v1/play/',
        prepareUrl: function (webrtcUrl) {
            var urlObject = self.__internal.parse(webrtcUrl);

            var schema = urlObject.user_query.schema;
            schema = schema ? schema + ':' : window.location.protocol;

            var port = urlObject.port || 1985;
            if (schema === 'https:') {
                port = urlObject.port || 8443;
            }

            var api = urlObject.user_query.play || self.__internal.defaultPath;
            if (api.lastIndexOf('/') !== api.length - 1) {
                api += '/';
            }

            var apiUrl = schema + '//' + urlObject.server + ':' + port + api;
            for (var key in urlObject.user_query) {
                if (key !== 'api' && key !== 'play') {
                    apiUrl += '&' + key + '=' + urlObject.user_query[key];
                }
            }
            apiUrl = apiUrl.replace(api + '&', api + '?');

            var streamUrl = urlObject.url;

            return {
                apiUrl: apiUrl, streamUrl: streamUrl, schema: schema, urlObject: urlObject, port: port,
                tid: Number(parseInt(new Date().getTime()*Math.random()*100)).toString(16).slice(0, 7)
            };
        },
        parse: function (url) {
            var a = document.createElement("a");
            a.href = url.replace("rtmp://", "http://")
                .replace("webrtc://", "http://")
                .replace("rtc://", "http://");

            var vhost = a.hostname;
            var app = a.pathname.substring(1, a.pathname.lastIndexOf("/"));
            var stream = a.pathname.slice(a.pathname.lastIndexOf("/") + 1);

            app = app.replace("...vhost...", "?vhost=");
            if (app.indexOf("?") >= 0) {
                var params = app.slice(app.indexOf("?"));
                app = app.slice(0, app.indexOf("?"));

                if (params.indexOf("vhost=") > 0) {
                    vhost = params.slice(params.indexOf("vhost=") + "vhost=".length);
                    if (vhost.indexOf("&") > 0) {
                        vhost = vhost.slice(0, vhost.indexOf("&"));
                    }
                }
            }

            if (a.hostname === vhost) {
                var re = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
                if (re.test(a.hostname)) {
                    vhost = "__defaultVhost__";
                }
            }

            var schema = "rtmp";
            if (url.indexOf("://") > 0) {
                schema = url.slice(0, url.indexOf("://"));
            }

            var port = a.port;
            if (!port) {
                if (schema === 'webrtc' && url.indexOf(`webrtc://${a.host}:`) === 0) {
                    port = (url.indexOf(`webrtc://${a.host}:80`) === 0) ? 80 : 8443;
                }

                if (schema === 'http') {
                    port = 80;
                } else if (schema === 'https') {
                    port = 8443;
                } else if (schema === 'rtmp') {
                    port = 1935;
                }
            }

            var ret = {
                url: url,
                schema: schema,
                server: a.hostname, port: port,
                vhost: vhost, app: app, stream: stream
            };
            self.__internal.fill_query(a.search, ret);

            if (!ret.port) {
                if (schema === 'webrtc' || schema === 'rtc') {
                    if (ret.user_query.schema === 'https') {
                        ret.port = 8443;
                    } else if (window.location.href.indexOf('https://') === 0) {
                        ret.port = 8443;
                    } else {
                        ret.port = 1985;
                    }
                }
            }

            return ret;
        },
        fill_query: function (query_string, obj) {
            obj.user_query = {};

            if (query_string.length === 0) {
                return;
            }

            if (query_string.indexOf("?") >= 0) {
                query_string = query_string.split("?")[1];
            }

            var queries = query_string.split("&");
            for (var i = 0; i < queries.length; i++) {
                var elem = queries[i];

                var query = elem.split("=");
                obj[query[0]] = query[1];
                obj.user_query[query[0]] = query[1];
            }

            if (obj.domain) {
                obj.vhost = obj.domain;
            }
        }
    };

    self.pc = new RTCPeerConnection(null);

    // Create a stream to add track to the stream, @see https://webrtc.org/getting-started/remote-streams
    self.stream = new MediaStream();

    // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/ontrack
    self.pc.ontrack = function(event) {
        if (self.ontrack) {
            self.ontrack(event);
        }
        self.stream.addTrack(event.track);
    };

    return self;
}

// Depends on adapter-7.4.0.min.js from https://github.com/webrtc/adapter
// Async-awat-prmise based SRS RTC Publisher by WHIP/WHEP with auto-adapt.
function SrsRtcWhipWhepAsync() {
    var self = {};

    // Utils
    function str2bool(v, dft) {
        if (v === undefined) return dft;
        v = ('' + v).toLowerCase();
        return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
    }
    function detectKindsFromSdp(sdp) {
        const hasAudio = /(^|\r\n)m=audio\s/i.test(sdp);
        const hasVideo = /(^|\r\n)m=video\s/i.test(sdp);
        return {audio: !!hasAudio, video: !!hasVideo};
    }
    function parseQuery(url) {
        const a = document.createElement('a'); a.href = url;
        const m = {};
        const s = (a.search || '').replace(/^\?/, '');
        if (!s) return m;
        s.split('&').forEach(kv=>{
            const [k,v] = kv.split('=');
            if (k) m[k] = v;
        });
        return m;
    }

    // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
    self.constraints = {
        audio: true,
        video: {
            width: {ideal: 320, max: 576}
        }
    };

    // WHIP publish unchanged.
    self.publish = async function (url) {
        if (url.indexOf('/whip/') === -1) throw new Error(`invalid WHIP url ${url}`);

        self.pc.addTransceiver("audio", {direction: "sendonly"});
        self.pc.addTransceiver("video", {direction: "sendonly"});

        if (!navigator.mediaDevices && window.location.protocol === 'http:' && window.location.hostname !== 'localhost') {
            throw new SrsError('HttpsRequiredError', `Please use HTTPS or localhost to publish, read https://github.com/ossrs/srs/issues/2762#issuecomment-983147576`);
        }
        var stream = await navigator.mediaDevices.getUserMedia(self.constraints);

        stream.getTracks().forEach(function (track) {
            self.pc.addTrack(track);
            self.ontrack && self.ontrack({track: track});
        });

        var offer = await self.pc.createOffer();
        await self.pc.setLocalDescription(offer);
        const answer = await new Promise(function (resolve, reject) {
            console.log("Generated offer: ", offer);

            const xhr = new XMLHttpRequest();
            xhr.onload = function() {
                if (xhr.readyState !== xhr.DONE) return;
                if (xhr.status !== 200 && xhr.status !== 201) return reject(xhr);
                const data = xhr.responseText;
                console.log("Got answer: ", data);
                return resolve(data);
            }
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-type', 'application/sdp');
            xhr.send(offer.sdp);
        });
        await self.pc.setRemoteDescription(
            new RTCSessionDescription({type: 'answer', sdp: answer})
        );

        return self.__internal.parseId(url, offer.sdp, answer);
    };

    // WHEP play with auto-adapt.
    self.play = async function(url) {
        if (url.indexOf('/whip-play/') === -1 && url.indexOf('/whep/') === -1) throw new Error(`invalid WHEP url ${url}`);

        const uq = parseQuery(url);
        let wantAudio = str2bool(uq.audio, true);
        let wantVideo = str2bool(uq.video, true);
        const forced = (uq.audio !== undefined) || (uq.video !== undefined);
        if (!wantAudio && !wantVideo) throw new SrsError('ParamError', 'Both audio and video are disabled (audio=0&video=0).');

        const setupPc = (audio, video) => {
            if (self.pc) { try { self.pc.close(); } catch (e) {} }
            self.pc = new RTCPeerConnection(null);
            self.pc.ontrack = function(event) {
                self.stream.addTrack(event.track);
                if (self.ontrack) self.ontrack(event);
            };
            if (audio) self.pc.addTransceiver("audio", {direction: "recvonly"});
            if (video) self.pc.addTransceiver("video", {direction: "recvonly"});
        };

        const postSdp = async (offerSdp) => {
            return await new Promise(function(resolve, reject) {
                console.log("Generated offer: ", {sdp: offerSdp});
                const xhr = new XMLHttpRequest();
                xhr.onload = function() {
                    if (xhr.readyState !== xhr.DONE) return;
                    if (xhr.status !== 200 && xhr.status !== 201) return reject(xhr);
                    const data = xhr.responseText;
                    console.log("Got answer: ", data);
                    return resolve(data);
                }
                xhr.open('POST', url, true);
                xhr.setRequestHeader('Content-type', 'application/sdp');
                xhr.send(offerSdp);
            });
        };

        // First try with user preference/both.
        setupPc(wantAudio, wantVideo);
        let offer = await self.pc.createOffer();
        await self.pc.setLocalDescription(offer);

        let answer = await postSdp(offer.sdp);
        let remoteKinds = detectKindsFromSdp(answer);
        const localCount = (wantAudio?1:0)+(wantVideo?1:0);
        const remoteCount = (remoteKinds.audio?1:0)+(remoteKinds.video?1:0);

        let needRetry = (!forced) && (
            localCount !== remoteCount ||
            (wantAudio && !remoteKinds.audio) ||
            (wantVideo && !remoteKinds.video)
        );

        if (needRetry) {
            console.warn('[SRS][WHEP] SDP kinds mismatch, auto-retry with remote kinds:', remoteKinds);
            if (!remoteKinds.audio && !remoteKinds.video) {
                // Fallback try video-only then audio-only
                setupPc(false, true);
                offer = await self.pc.createOffer();
                await self.pc.setLocalDescription(offer);
                try {
                    answer = await postSdp(offer.sdp);
                    await self.pc.setRemoteDescription(new RTCSessionDescription({type:'answer', sdp: answer}));
                } catch (e2) {
                    setupPc(true, false);
                    offer = await self.pc.createOffer();
                    await self.pc.setLocalDescription(offer);
                    answer = await postSdp(offer.sdp);
                    await self.pc.setRemoteDescription(new RTCSessionDescription({type:'answer', sdp: answer}));
                }
            } else {
                setupPc(remoteKinds.audio, remoteKinds.video);
                offer = await self.pc.createOffer();
                await self.pc.setLocalDescription(offer);
                answer = await postSdp(offer.sdp);
                await self.pc.setRemoteDescription(new RTCSessionDescription({type:'answer', sdp: answer}));
            }
        } else {
            try {
                await self.pc.setRemoteDescription(new RTCSessionDescription({type:'answer', sdp: answer}));
            } catch (err) {
                if (!forced && (err.name === 'InvalidAccessError' || /m-lines|order.*m-lines/i.test(err.message||''))) {
                    console.warn('[SRS][WHEP] setRemoteDescription failed, auto-fallback with remote kinds:', remoteKinds, err);
                    setupPc(remoteKinds.audio, remoteKinds.video);
                    offer = await self.pc.createOffer();
                    await self.pc.setLocalDescription(offer);
                    answer = await postSdp(offer.sdp);
                    await self.pc.setRemoteDescription(new RTCSessionDescription({type:'answer', sdp: answer}));
                } else {
                    throw err;
                }
            }
        }

        return self.__internal.parseId(url, offer.sdp, answer);
    };

    // Close the publisher/player.
    self.close = function () {
        self.pc && self.pc.close();
        self.pc = null;
    };

    // The callback when got local/remote stream.
    self.ontrack = function (event) {
        self.stream.addTrack(event.track);
    };

    self.pc = new RTCPeerConnection(null);

    // To keep api consistent between player and publisher.
    self.stream = new MediaStream();

    // Internal APIs.
    self.__internal = {
        parseId: (url, offer, answer) => {
            let sessionid = offer.substr(offer.indexOf('a=ice-ufrag:') + 'a=ice-ufrag:'.length);
            sessionid = sessionid.substr(0, sessionid.indexOf('\n') - 1) + ':';
            sessionid += answer.substr(answer.indexOf('a=ice-ufrag:') + 'a=ice-ufrag:'.length);
            sessionid = sessionid.substr(0, sessionid.indexOf('\n'));

            const a = document.createElement("a");
            a.href = url;
            return {
                sessionid: sessionid, // Should be ice-ufrag of answer:offer.
                simulator: a.protocol + '//' + a.host + '/rtc/v1/nack/',
            };
        },
    };

    // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/ontrack
    self.pc.ontrack = function(event) {
        if (self.ontrack) {
            self.ontrack(event);
        }
    };

    return self;
}

// Format the codec of RTCRtpSender, kind(audio/video) is optional filter.
function SrsRtcFormatSenders(senders, kind) {
    var codecs = [];
    senders.forEach(function (sender) {
        var params = sender.getParameters();
        params && params.codecs && params.codecs.forEach(function(c) {
            if (kind && sender.track && sender.track.kind !== kind) {
                return;
            }

            if (c.mimeType.indexOf('/red') > 0 || c.mimeType.indexOf('/rtx') > 0 || c.mimeType.indexOf('/fec') > 0) {
                return;
            }

            var s = '';

            s += c.mimeType.replace('audio/', '').replace('video/', '');
            s += ', ' + c.clockRate + 'HZ';
            if (sender.track && sender.track.kind === "audio") {
                s += ', channels: ' + c.channels;
            }
            s += ', pt: ' + c.payloadType;

            codecs.push(s);
        });
    });
    return codecs.join(", ");
}
