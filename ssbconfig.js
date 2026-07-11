"use strict";

module.exports.ssbconfig = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  obj.debug = obj.meshServer.debug;
  obj.VIEWS = __dirname + "/views/";

  obj.server_startup = function () {
    obj.debug("plugin:ssbconfig", "scaffold plugin started");
  };

  obj.handleAdminReq = function (req, res, user) {
    if (!user || !user.siteadmin) {
      res.status(403).send("Forbidden");
      return;
    }

    res.render(obj.VIEWS + "admin", {
      pluginName: "SSB Config (Scaffold Only)",
      message: "This plugin is intentionally empty."
    });
  };

  obj.handleAdminPostReq = function (req, res, user) {
    if (!user || !user.siteadmin) {
      res.status(403).send("Forbidden");
      return;
    }

    res.status(501);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify({
      error: "ssbconfig scaffold has no backend API"
    }));
  };

  return obj;
};
