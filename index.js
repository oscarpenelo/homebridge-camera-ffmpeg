var Accessory, Service, Characteristic, hap, UUIDGen;
var rpio = require('rpio');

var FFMPEG = require('./ffmpeg').FFMPEG;
module.exports = function(homebridge) {
  Accessory = homebridge.platformAccessory;
  hap = homebridge.hap;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerPlatform("homebridge-camera-ffmpeg-doorbell", "Camera-ffmpeg", ffmpegPlatform, true);
}
/*
 {
            "cameras": [
                {
                    "name": "Pi Cam",
                    "videoConfig": {
                        "source": "-f alsa -ac 1 -thread_queue_size 2048 -i hw:1 -f image2 -loop 1 -pix_fmt rgb24 -i /homebridge/image.jpg -vsync 0 -af aresample=async=1",
                        "stillImageSource": "-f image2 -loop 1 -pix_fmt yuvj422p -s 640x640 -i /homebridge/image.jpg",
                        "maxStreams": 2,
                        "maxWidth": 1270,
                        "maxHeight": 720,
                        "maxFPS": 30,
                        "maxBitrate": 10,
                        "mapvideo": "1,0",
                        "packetSize": 188,
                        "mapaudio": "0,0",
                        "audio": "2way -f alsa default",
                        "debug": true
                    }
                }
            ],
            "bell": {
                "pin": 16,
                "powerpin": 22
            },
            "locker": {
                "pin": 18,
                "seconds": 2
            },
            "platform": "Camera-ffmpeg"
        }
 */
function ffmpegPlatform(log, config, api) {
  var self = this;
  self.belldetected= false;
  self.unlocked=false
  self.log = log;
  self.config = config || {};
  self.bellpin= Number(config.bell.pin);
  self.bellpowerpin=Number(config.bell.powerpin);
  self.lockerpin=Number(config.locker.pin);
  self.lockerseconds=Number(config.locker.seconds);
  if (api) {
    self.api = api;

    if (api.version < 2.1) {
      throw new Error("Unexpected API version.");
    }

    self.api.on('didFinishLaunching', self.didFinishLaunching.bind(this));
  }
}

ffmpegPlatform.prototype.configureAccessory = function(accessory) {
  // Won't be invoked
}

ffmpegPlatform.prototype.didFinishLaunching = function() {
  var self = this;
  var videoProcessor = self.config.videoProcessor || 'ffmpeg';
  var interfaceName = self.config.interfaceName || '';










  if (self.config.cameras) {
    var configuredAccessories = [];

    var cameras = self.config.cameras;
    cameras.forEach(function(cameraConfig) {
      var cameraName = cameraConfig.name;
      var videoConfig = cameraConfig.videoConfig;

      if (!cameraName || !videoConfig) {
        self.log("Missing parameters.");
        return;
      }

      var uuid = UUIDGen.generate(cameraName);
      var cameraAccessory = new Accessory(cameraName, uuid, hap.Accessory.Categories.CAMERA);
      var cameraAccessoryInfo = cameraAccessory.getService(Service.AccessoryInformation);
      if (cameraConfig.manufacturer) {
        cameraAccessoryInfo.setCharacteristic(Characteristic.Manufacturer, cameraConfig.manufacturer);
      }
      if (cameraConfig.model) {
        cameraAccessoryInfo.setCharacteristic(Characteristic.Model, cameraConfig.model);
      }
      if (cameraConfig.serialNumber) {
        cameraAccessoryInfo.setCharacteristic(Characteristic.SerialNumber, cameraConfig.serialNumber);
      }
      if (cameraConfig.firmwareRevision) {
        cameraAccessoryInfo.setCharacteristic(Characteristic.FirmwareRevision, cameraConfig.firmwareRevision);
      }






      cameraAccessory.context.log = self.log;

      rpio.open(self.bellpowerpin, rpio.OUTPUT, rpio.LOW);
      rpio.sleep(1);

      rpio.write(self.bellpowerpin, rpio.HIGH);
      rpio.open(self.bellpin, rpio.INPUT);
      rpio.poll(self.bellpin, self.gpioChange.bind(self), rpio.POLL_LOW);
      rpio.open(self.lockerpin, rpio.OUTPUT, rpio.HIGH);


      self.motion = new Service.MotionSensor(cameraName);
      cameraAccessory.addService(self.motion);
      self.motion.getCharacteristic(Characteristic.MotionDetected)
          .on('get', self.getmotion.bind(self));

      self.switch =   new Service.LockMechanism(cameraName)

      cameraAccessory.addService(self.switch);

      self.switch.getCharacteristic(Characteristic.LockTargetState)
          .on('set', self.setlocker.bind(self))

      self.switch.getCharacteristic(Characteristic.LockCurrentState).updateValue(1)

      self.switch.getCharacteristic(Characteristic.LockTargetState).updateValue(1)

      var cameraSource = new FFMPEG(hap, cameraConfig, self.log, videoProcessor, interfaceName);
      cameraAccessory.configureCameraSource(cameraSource);
      configuredAccessories.push(cameraAccessory);
    });
    MODULE=self
    self.api.publishCameraAccessories("Camera-ffmpeg", configuredAccessories);
  }
};
ffmpegPlatform.prototype.gpioChange = function (pin,callback) {
  if (!this.belldetected) {
    this.belldetected = true;
    this.motion.getCharacteristic(Characteristic.MotionDetected)
        .updateValue(this.belldetected, null, "gpioChange");
    this.log("POWER OFF");
    rpio.write(this.bellpowerpin, rpio.LOW);

    setTimeout(() => {
      this.log("POWER ON");

      rpio.write(this.bellpowerpin, rpio.HIGH);


    },250);



    this.timeout = setTimeout(function () {
      this.log("Resetting gpio change event throttle flag");
      this.belldetected = false;

      this.motion.getCharacteristic(Characteristic.MotionDetected)
          .updateValue(this.belldetected, null, "gpioChange");

    }, 11*1000);
  }
  callback();

};
ffmpegPlatform.prototype.setlocker = function  (turnOn, callback) {
  if(turnOn===Characteristic.LockTargetState.UNSECURED) {
    callback()

    this.switch.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.UNSECURED)

    this.log("turnon");

    rpio.write(this.lockerpin, rpio.LOW);
    rpio.sleep(this.lockerseconds);
    rpio.write(this.lockerpin, rpio.HIGH);

    this.switch.setCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED)

  }
  else{
    callback()

    this.switch.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.SECURED)

  }

}
ffmpegPlatform.prototype.getmotion =  function (callback) {

  this.log("getmotion");


  callback(null, this.belldetected);
};

function _Motion(on, callback) {
  this.context.log("Setting %s Motion to %s", this.displayName, on);

  this.getService(Service.MotionSensor).setCharacteristic(Characteristic.MotionDetected, (on ? 1 : 0));
  if (on) {
    setTimeout(_Reset.bind(this), 5000);
  }
  callback();
}

function _Reset() {
  this.context.log("Setting %s Button to false", this.displayName);

  this.getService(Service.Switch).setCharacteristic(Characteristic.On, false);
}
