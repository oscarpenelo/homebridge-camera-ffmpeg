'use strict';
var uuid, Service, Characteristic, StreamController;

var crypto = require('crypto');
var fs = require('fs');
var ip = require('ip');
var spawn = require('child_process').spawn;
var drive = require('./drive').drive;

const dgram = require('dgram');

module.exports = {
  FFMPEG: FFMPEG
};

function FFMPEG(hap, cameraConfig, log, videoProcessor, interfaceName) {
  uuid = hap.uuid;
  Service = hap.Service;
  Characteristic = hap.Characteristic;
  StreamController = hap.StreamController;
  this.log = log;

  var ffmpegOpt = cameraConfig.videoConfig;
  this.name = cameraConfig.name;
  this.vcodec = ffmpegOpt.vcodec;
  this.videoProcessor = videoProcessor || 'ffmpeg';
  this.audio = ffmpegOpt.audio;
  this.acodec = ffmpegOpt.acodec;
  this.packetsize = ffmpegOpt.packetSize;
  this.fps = ffmpegOpt.maxFPS || 10;
  this.maxBitrate = ffmpegOpt.maxBitrate || 300;
  this.debug = ffmpegOpt.debug;
  this.additionalCommandline = ffmpegOpt.additionalCommandline || '-tune zerolatency';
  this.vflip = ffmpegOpt.vflip || false;
  this.hflip = ffmpegOpt.hflip || false;
  this.mapvideo = ffmpegOpt.mapvideo || "0:0";
  this.mapaudio = ffmpegOpt.mapaudio || "0:1";
  this.videoFilter = ffmpegOpt.videoFilter || null; // null is a valid discrete value
  this.interfaceName = interfaceName;

  if (!ffmpegOpt.source) {
    throw new Error("Missing source for camera.");
  }

  this.ffmpegSource = ffmpegOpt.source;
  this.ffmpegImageSource = ffmpegOpt.stillImageSource;

  this.services = [];
  this.streamControllers = [];

  this.pendingSessions = {};
  this.ongoingSessions = {};

  this.uploader = cameraConfig.uploader || false;
  if ( this.uploader )
    { this.drive = new drive(); }

  var numberOfStreams = ffmpegOpt.maxStreams || 2;
  var videoResolutions = [];

  this.maxWidth = ffmpegOpt.maxWidth || 1280;
  this.maxHeight = ffmpegOpt.maxHeight || 720;
  var maxFPS = (this.fps > 30) ? 30 : this.fps;

  if (this.maxWidth >= 320) {
    if (this.maxHeight >= 240) {
      videoResolutions.push([320, 240, maxFPS]);
      if (maxFPS > 15) {
        videoResolutions.push([320, 240, 15]);
      }
    }

    if (this.maxHeight >= 180) {
      videoResolutions.push([320, 180, maxFPS]);
      if (maxFPS > 15) {
        videoResolutions.push([320, 180, 15]);
      }
    }
  }

  if (this.maxWidth >= 480) {
    if (this.maxHeight >= 360) {
      videoResolutions.push([480, 360, maxFPS]);
    }

    if (this.maxHeight >= 270) {
      videoResolutions.push([480, 270, maxFPS]);
    }
  }

  if (this.maxWidth >= 640) {
    if (this.maxHeight >= 480) {
      videoResolutions.push([640, 480, maxFPS]);
    }

    if (this.maxHeight >= 360) {
      videoResolutions.push([640, 360, maxFPS]);
    }
  }

  if (this.maxWidth >= 1280) {
    if (this.maxHeight >= 960) {
      videoResolutions.push([1280, 960, maxFPS]);
    }

    if (this.maxHeight >= 720) {
      videoResolutions.push([1280, 720, maxFPS]);
    }
  }

  if (this.maxWidth >= 1920) {
    if (this.maxHeight >= 1080) {
      videoResolutions.push([1920, 1080, maxFPS]);
    }
  }

  let options = {
    proxy: false, // Requires RTP/RTCP MUX Proxy
    srtp: true, // Supports SRTP AES_CM_128_HMAC_SHA1_80 encryption
    video: {
      resolutions: videoResolutions,
      codec: {
        profiles: [0, 1, 2], // Enum, please refer StreamController.VideoCodecParamProfileIDTypes
        levels: [0, 1, 2] // Enum, please refer StreamController.VideoCodecParamLevelTypes
      }
    },
    audio: {
      codecs: [
        {
          type: "OPUS", // Audio Codec
          samplerate: 24 // 8, 16, 24 KHz
        },
        {
          type: "AAC-eld",
          samplerate: 16
        }
      ]
    }
  }

  this.createCameraControlService();
  this._createStreamControllers(numberOfStreams, options);
}

FFMPEG.prototype.handleCloseConnection = function(connectionID) {
  this.streamControllers.forEach(function(controller) {
    controller.handleCloseConnection(connectionID);
  });
}

FFMPEG.prototype.handleSnapshotRequest = function(request, callback) {
  let resolution = request.width + 'x' + request.height;
  var imageSource = this.ffmpegImageSource !== undefined ? this.ffmpegImageSource : this.ffmpegSource;
  let ffmpeg = spawn(this.videoProcessor, (imageSource + ' -t 1 -s '+ resolution + ' -f image2 -').split(' '), {env: process.env});
  var imageBuffer = Buffer.alloc(0);
  this.log("Snapshot from " + this.name + " at " + resolution);
  if(this.debug) console.log('ffmpeg '+imageSource + ' -t 1 -s '+ resolution + ' -f image2 -');
  ffmpeg.stdout.on('data', function(data) {
    imageBuffer = Buffer.concat([imageBuffer, data]);
  });
  let self = this;
  ffmpeg.on('error', function(error){
    self.log("An error occurs while making snapshot request");
    self.debug ? self.log(error) : null;
  });
  ffmpeg.on('close', function(code) {
    if ( this.uploader )
      { this.drive.storePicture(this.name,imageBuffer); }
    callback(undefined, imageBuffer);
  }.bind(this));
}

FFMPEG.prototype.prepareStream = function(request, callback) {
  var sessionInfo = {};

  let sessionID = request["sessionID"];
  let targetAddress = request["targetAddress"];

  sessionInfo["address"] = targetAddress;

  var response = {};

  let videoInfo = request["video"];
  if (videoInfo) {
    let targetPort = videoInfo["port"];
    let srtp_key = videoInfo["srtp_key"];
    let srtp_salt = videoInfo["srtp_salt"];

    // SSRC is a 32 bit integer that is unique per stream
    let ssrcSource = crypto.randomBytes(4);
    ssrcSource[0] = 0;
    let ssrc = ssrcSource.readInt32BE(0, true);

    let videoResp = {
      port: targetPort,
      ssrc: ssrc,
      srtp_key: srtp_key,
      srtp_salt: srtp_salt
    };

    response["video"] = videoResp;

    sessionInfo["video_port"] = targetPort;
    sessionInfo["video_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
    sessionInfo["video_ssrc"] = ssrc;
  }

  let audioInfo = request["audio"];
  if (audioInfo) {
    let targetPort = audioInfo["port"];
    let srtp_key = audioInfo["srtp_key"];
    let srtp_salt = audioInfo["srtp_salt"];

    // SSRC is a 32 bit integer that is unique per stream
    let ssrcSource = crypto.randomBytes(4);
    ssrcSource[0] = 0;
    let ssrc = ssrcSource.readInt32BE(0, true);

    let audioResp = {
      port: targetPort,
      ssrc: ssrc,
      srtp_key: srtp_key,
      srtp_salt: srtp_salt
    };

    response["audio"] = audioResp;

    sessionInfo["audio_port"] = targetPort;
    sessionInfo["audio_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
    sessionInfo["audio_ssrc"] = ssrc;
  }

  let currentAddress = ip.address(this.interfaceName);
  var addressResp = {
    address: currentAddress
  };

  if (ip.isV4Format(currentAddress)) {
    addressResp["type"] = "v4";
  } else {
    addressResp["type"] = "v6";
  }

  response["address"] = addressResp;
  this.pendingSessions[uuid.unparse(sessionID)] = sessionInfo;

  callback(response);
}

FFMPEG.prototype.handleStreamRequest = function(request) {
  if (this.debug) this.log(request);
  var sessionID = request["sessionID"];
  var requestType = request["type"];
  if (sessionID) {
    let sessionIdentifier = uuid.unparse(sessionID);

    if (requestType == "start") {
      var sessionInfo = this.pendingSessions[sessionIdentifier];
      if (sessionInfo) {
        var width = 1280;
        var height = 720;
        var fps = this.fps || 30;
        var vbitrate = this.maxBitrate;
        var abitrate = 32;
        var asamplerate = 16;
        var vcodec = this.vcodec || 'libx264';
        var acodec = this.acodec || 'libfdk_aac';
        var packetsize = this.packetsize || 1316; // 188 376
        var additionalCommandline = this.additionalCommandline;
        var mapvideo = this.mapvideo;
        var mapaudio = this.mapaudio;

        let videoInfo = request["video"];
        if (videoInfo) {
          width = videoInfo["width"];
          height = videoInfo["height"];

          let expectedFPS = videoInfo["fps"];
          if (expectedFPS < fps) {
            fps = expectedFPS;
          }
          if(videoInfo["max_bit_rate"] < vbitrate) {
            vbitrate = videoInfo["max_bit_rate"];
          }
        }

        let audioInfo = request["audio"];
        if (audioInfo) {
          abitrate = audioInfo["max_bit_rate"];
          asamplerate = audioInfo["sample_rate"];
        }

        let targetAddress = sessionInfo["address"];
        let targetVideoPort = sessionInfo["video_port"];
        let videoKey = sessionInfo["video_srtp"];
        let videoSsrc = sessionInfo["video_ssrc"];
        let targetAudioPort = sessionInfo["audio_port"];
        let audioKey = sessionInfo["audio_srtp"];
        let audioSsrc = sessionInfo["audio_ssrc"];
        let vf = [];

        let videoFilter = ((this.videoFilter === '') ? ('scale=' + width + ':' + height + '') : (this.videoFilter)); // empty string indicates default
        // In the case of null, skip entirely
        if (videoFilter !== null && videoFilter !== 'none') {
          vf.push(videoFilter)

          if(this.hflip)
            vf.push('hflip');

          if(this.vflip)
            vf.push('vflip');
        }

        let fcmd = this.ffmpegSource;

        let ffmpegVideoArgs = ' -map ' + mapvideo +
          ' -vcodec ' + vcodec +
          ' -pix_fmt yuv420p' +
          ' -r ' + fps +
          ' -f rawvideo' +
          ' ' + additionalCommandline +
          ((vf.length > 0) ? (' -vf ' + vf.join(',')) : ('')) +
          ' -b:v ' + vbitrate + 'k' +
          ' -bufsize ' + vbitrate+ 'k' +
          ' -maxrate '+ vbitrate + 'k' +
          ' -payload_type 99';

        let ffmpegVideoStream = ' -ssrc ' + videoSsrc +
          ' -f rtp' +
          ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
          ' -srtp_out_params ' + videoKey.toString('base64') +
          ' srtp://' + targetAddress + ':' + targetVideoPort +
          '?rtcpport=' + targetVideoPort +
          '&localrtcpport=' + targetVideoPort +
          '&pkt_size=' + packetsize;

        // build required video arguments
        fcmd += ffmpegVideoArgs;
        fcmd += ffmpegVideoStream;
        let kill = spawn("killall","-9","ffmpeg");
        this.log("killall -9 ffmpeg");
        // build optional audio arguments
        if(this.audio) {
          let ffmpegAudioArgs = ' -map ' + mapaudio +
              ' -acodec ' + acodec +
              ' -profile:a aac_eld' +
              ' -flags +global_header' +
              ' -f null' +
              ' -ar ' + asamplerate + 'k' +
              ' -b:a ' + abitrate + 'k' +
              ' -bufsize ' + abitrate + 'k' +
              ' -ac 1' +
              ' -payload_type 110';

          let ffmpegAudioStream = ' -ssrc ' + audioSsrc +
              ' -f rtp' +
              ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
              ' -srtp_out_params ' + audioKey.toString('base64') +
              ' srtp://' + (String(this.audio).startsWith("2way") ? '127.0.0.1': targetAddress) + ':' + targetAudioPort +
              '?rtcpport=' + targetAudioPort +
              '&localrtcpport=' + (String(this.audio).startsWith("2way") ? "9998" : targetAudioPort) +
              '&pkt_size=' + packetsize;

          fcmd += ffmpegAudioArgs;
          fcmd += ffmpegAudioStream;
        }

        if (this.debug) {
          fcmd += ' -loglevel debug';
        }
        //kill
        let ffmpeg = spawn(this.videoProcessor, fcmd.split(' '), {env: process.env});

        // start the process


        this.log("Start streaming video from " + this.name + " with " + width + "x" + height + "@" + vbitrate + "kBit");
        if(this.debug){
          console.log("ffmpeg " + fcmd);
        }

        // Always setup hook on stderr.
        // Without this streaming stops within one to two minutes.
        ffmpeg.stderr.on('data', function(data) {
          // Do not log to the console if debugging is turned off
          if(this.debug){
            console.log(data.toString());
          }
        }.bind(this));
        let self = this;
        ffmpeg.on('error', function(error){
            self.log("An error occurs while making stream request");
            self.debug ? self.log(error) : null;
            if (self.proxySocket) { self.proxySocket.close(); self.proxySocket = null; }
        });
        ffmpeg.on('close', (code) => {
          if(code == null || code == 0 || code == 255){
            self.log("Stopped streaming");
          } else {
            self.log("ERROR: FFmpeg exited with code " + code);
            for(var i=0; i < self.streamControllers.length; i++){
              var controller = self.streamControllers[i];
              if(controller.sessionIdentifier === sessionID){
                controller.forceStop();
              }
            }
          }
          if (self.proxySocket) { self.proxySocket.close(); self.proxySocket = null; }
        });
        this.ongoingSessions[sessionIdentifier] = ffmpeg;

        if (String(this.audio).startsWith("2way")) {
  			// setup udp proxy
      		// todo: there can be just one client sending audio to cam
      		// todo: config ports

  			this.proxySocket = dgram.createSocket('udp4');
  			const proxy = this.proxySocket;

  			proxy.on('error', (err) => {
  			  console.log(`server error:\n${err.stack}`);
  			  proxy.close();
  			});

  			proxy.on('message', (msg, rinfo) => {
  			//  console.log(`server got: ${msg[1]} from ${rinfo.address}:${rinfo.port}`); // msg[1] -> PT -> 238/110 rtp 200/72 rtcp
  			// if src port == targetAudioPort send to port 9998 9999 else send to targetAudioPort
  				if (rinfo.port == targetAudioPort) {
  				// todo?: demux rtcp based on direction req/ans
  					proxy.send(msg, 9998, '127.0.0.1', (err) => {
  	  					if (err) console.log(err);
  	  				//	else console.log('sent to 9998');
  					});
  					proxy.send(msg, 9999, '127.0.0.1', (err) => {
  	  					if (err) console.log(err);
  	  				//	else console.log('sent to 9999');
  					});
  				} else {
  					proxy.send(msg, targetAudioPort, targetAddress, (err) => {
  	  					if (err) console.log(err);
  	  				//	else console.log('sent to ' + targetAudioPort);
  					});
  				}
  			});

  			proxy.on('listening', () => {
  			  const address = proxy.address();
  			  console.log(`proxy listening ${address.address}:${address.port}`);
  			});

  			proxy.bind(targetAudioPort);

  			//console.log(process.env);
  		    //console.log(process.cwd());
      		let sdp =
  				"v=0\n" +
  				"o=- 0 0 IN IP4 127.0.0.1\n" +
  				"s=No Name\n" +
  				"c=IN IP4 127.0.0.1\n" +
  				"t=0 0\n" +
  			//	"a=tool:libavformat 58.12.100\n" +
  				"m=audio 9999 RTP/AVP 110\n" +
  				"b=AS:"+ abitrate + "\n" + // todo: verify!
  				"a=rtpmap:110 MPEG4-GENERIC/16000/1\n" +
  				"a=fmtp:110 profile-level-id=1; mode=AAC-hbr; sizelength=13; indexlength=3; indexdeltalength=3; config=F8EA2000\n" + // todo?: put sample rate into config= too
  				"a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:" + audioKey.toString('base64');

   			var speakerSdpFilename = "/homebridge/" + this.name.replace(/\s+/g, '_') + "_speaker.sdp"; // todo: filter all illegal filename chars from this.name
   			this.speakerSource = ' -max_ts_probe 0 -protocol_whitelist file,udp,rtp -i ' + speakerSdpFilename;
   			this.speakerOut = (typeof this.audio === "string" && this.audio.length > 4) ? this.audio.substring(4) : ' -y speaker.mp4';
   			this.speakerCommand = this.speakerSource + this.speakerOut;
		      	    fs.writeFileSync(speakerSdpFilename, sdp);

      	    // spawn a second ffmpeg instance for speaker
      	    let ffmpegCommand = '-v error -nostats -nostdin ' + this.speakerCommand;
      	    let ffmpeg = spawn(this.videoProcessor, ffmpegCommand.split(/\s+/), {env: process.env});
          	if (this.debug) {
            		console.log("[Speaker] " + this.videoProcessor + " " + ffmpegCommand);
          	}
  	        // Always setup hook on stderr.
  	        // Without this streaming stops within one to two minutes.
  	        ffmpeg.stderr.on('data', (data) => {
  	          // Do not log to the console if debugging is turned off
  	          if (this.debug) {
  	            console.log("[Speaker] " + data.toString());
  	          }
  	        });
  	        ffmpeg.on('error', (error) => {
  	            this.log("An error occurs while making Speaker stream request");
  	            if (this.debug) this.log(error);
  	        });
  	        ffmpeg.on('close', (code) => {
  	          if(code == null || code == 0 || code == 255){
  	            this.log("Speaker Stopped streaming");
  	          } else {



  	            this.log("ERROR: Speaker FFmpeg exited with code " + code);
                ffmpeg = spawn(this.videoProcessor, ffmpegCommand.split(/\s+/), {env: process.env});



              }
  	        });
  	        // Speaker ffmpeg instance will timeout when main stops and then exits without need to kill
  	   //     this.ongoingSessions[sessionIdentifier] = ffmpeg;
  		}
        }

        delete this.pendingSessions[sessionIdentifier];
      } else if (requestType == "stop") {
        var ffmpegProcess = this.ongoingSessions[sessionIdentifier];
        if (ffmpegProcess) {
          ffmpegProcess.kill('SIGTERM');
        }
        delete this.ongoingSessions[sessionIdentifier];
        if (this.proxySocket) { this.proxySocket.close(); this.proxySocket = null; }
      }
    }
  }

  FFMPEG.prototype.createCameraControlService = function() {
    var controlService = new Service.CameraControl();

    this.services.push(controlService);

    if (this.audio) {
      var microphoneService = new Service.Microphone();
      this.services.push(microphoneService);
      if (String(this.audio).startsWith("2way")) {
      	var speakerService = new Service.Speaker();
      	this.services.push(speakerService);
      }
    }
  }

  // Private

  FFMPEG.prototype._createStreamControllers = function(maxStreams, options) {
    let self = this;

    for (var i = 0; i < maxStreams; i++) {
      var streamController = new StreamController(i, options, self);

      self.services.push(streamController.service);
      self.streamControllers.push(streamController);
    }
  }

