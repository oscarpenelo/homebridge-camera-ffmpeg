var Accessory, Service, Characteristic, hap, UUIDGen;
var gpio = require("rpi-gpio");

var FFMPEG = require('./ffmpeg').FFMPEG;

module.exports = function(homebridge) {
  Accessory = homebridge.platformAccessory;
  hap = homebridge.hap;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerPlatform("homebridge-camera-ffmpeg-doorbell", "Camera-ffmpeg", ffmpegPlatform, true);
}

function ffmpegPlatform(log, config, api) {
  var self = this;
  self.belldetected= false;
  self.unlocked=false
  self.log = log;
  self.config = config || {};
  self.bellgpio= config.bell.gpio;
  self.bellpowergpio=config.bell.powergpio;
  self.lockergpio=config.locker.gpio;
  self.lockerseconds=config.locker.seconds;
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



      gpio.setup(self.bellgpio, gpio.DIR_IN, gpio.EDGE_FALLING, function (err) {
        if (err != undefined) {
          that.log("Error setting up gpio pin: " + that.pin);
          that.log(err);
        }

        that.log("GPIO setup completed");

        gpio.on("change", function (channel, val) {
          that.gpioChange(that, channel, val);
        });
      });
      gpio.setup(self.bellpowergpio, gpio.DIR_OUT, function (err) {
        if (err != undefined) {
          that.log("Error setting up gpio pin: " + that.pin);
          that.log(err);
        }

        that.log("GPIO setup completed");
        return gpio.write(that.pin, true)

      });
      gpio.setup(self.lockergpio, gpio.DIR_OUT, function (err) {
        if (err != undefined) {
          that.log("Error setting up gpio pin: " + that.pin);
          that.log(err);
        }

        that.log("GPIO setup completed");
        return gpio.write(that.pin, false)

      });
      var motion = new Service.MotionSensor(cameraName);
      cameraAccessory.addService(motion);
      motion.getCharacteristic(Characteristic.MotionDetected)
          .on('get', self.getmotion.bind(cameraAccessory));

      var button = new Service.Switch(cameraName);
      cameraAccessory.addService(button);

      button.getCharacteristic(Characteristic.On)
          .on('set', self.setlocker.bind(this))

      button.setCharacteristic(
          Characteristic.On,
          Boolean(self.unlocked)
      )


      var cameraSource = new FFMPEG(hap, cameraConfig, self.log, videoProcessor, interfaceName);
      cameraAccessory.configureCameraSource(cameraSource);
      configuredAccessories.push(cameraAccessory);
    });

    self.api.publishCameraAccessories("Camera-ffmpeg", configuredAccessories);
  }
};
ffmpegPlatform.prototype.gpioChange = function (that, channel, val) {
  if (!that.belldetected) {
    that.belldetected = true;
    that.log("Got GPIO rising edge event");
    gpio.write(this.bellpowergpio, false)
    setTimeout(() => {
      gpio.write(this.bellpowergpio, false)


    },250);
    that.service.getCharacteristic(Characteristic.MotionDetected)
        .updateValue(that.belldetected, null, "gpioChange");

    if (that.timeout) clearTimeout(that.timeout);

    that.timeout = setTimeout(function () {
      that.log("Resetting gpio change event throttle flag");
      that.bellDetected = false;

      that.service.getCharacteristic(Characteristic.MotionDetected)
          .updateValue(that.belldetected, null, "gpioChange");

      that.timeout = null;
    }, that.reset);
  }
};
ffmpegPlatform.prototype.setlocker = function  (turnOn, callback) {
  gpio.write(that.lockergpio, true)
  setTimeout(() => {
    gpio.write(that.lockergpio, false)

  },that.lockerseconds*1000);
  callback()
}
ffmpegPlatform.prototype.getmotion =  function (callback) {
  var self = this;

  callback(null, that.belldetected);
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
