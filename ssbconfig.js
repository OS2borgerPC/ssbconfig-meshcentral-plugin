"use strict";

const fs = require("fs");
const path = require("path");
const {
  githubGetDefaultBranch,
  githubGetBranchHeadSha,
  githubGetDirectory,
  githubGetFileContent,
  githubCommitFiles
} = require("./lib/github-client");
const { createConfigService } = require("./lib/config-service");
const { createMeshcentralService } = require("./lib/meshcentral-service");

module.exports.ssbconfig = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  obj.debug = obj.meshServer.debug;
  obj.VIEWS = __dirname + "/views/";
  const configService = createConfigService({
    meshServer: obj.meshServer,
    pluginDir: __dirname,
    github: {
      githubGetDefaultBranch,
      githubGetBranchHeadSha,
      githubGetDirectory,
      githubGetFileContent
    }
  });
  const meshcentralService = createMeshcentralService(obj.meshServer, obj.debug);

  function canAccessPlugin(req, user) {
    if (user && user.siteadmin) return true;
    const domainId = configService.resolveRequestDomainId(req, user);
    return meshcentralService.isUserInOs2Group(obj.meshServer, user, domainId);
  }

  // Logs plugin startup for operational visibility in MeshCentral logs.
  obj.server_startup = function () {
    obj.debug("plugin:ssbconfig", "plugin started!!!");
    meshcentralService.ensureOs2UserGroupOnStartup();
  };

  // Handles admin GET routes: bundle asset serving, bootstrap payload, and main admin view.
  obj.handleAdminReq = async function (req, res, user) {
    if (!canAccessPlugin(req, user)) {
      res.status(403).send("Forbidden");
      return;
    }

    try {
      if (req.query && req.query.api === "asset") {
        const fileName = String(req.query.file || "");
        if (fileName !== "admin.bundle.js") {
          res.sendStatus(404);
          return;
        }

        const filePath = path.join(obj.VIEWS, "admin.bundle.js");
        if (!fs.existsSync(filePath)) {
          sendJson(res, 500, {
            error: "UI bundle not found. Run npm install && npm run build:ui in plugins/ssbconfig"
          });
          return;
        }

        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.send(fs.readFileSync(filePath, "utf8"));
        return;
      }

      if (req.query && req.query.api === "bootstrap") {
        const payload = await configService.getBootstrapPayload(req, user);
        sendJson(res, 200, payload);
        return;
      }

      res.render(obj.VIEWS + "admin", {
        pluginName: "Sikker Selvbetjening Config Editor",
        domainId: configService.resolveRequestDomainId(req, user)
      });
    } catch (error) {
      obj.debug("plugin:ssbconfig", "handleAdminReq error", error);
      sendJson(res, 500, { error: error.message || "Unexpected error" });
    }
  };

  // Handles admin POST routes for preview validation and save/commit operations.
  obj.handleAdminPostReq = async function (req, res, user) {
    if (!canAccessPlugin(req, user)) {
      res.status(403).send("Forbidden");
      return;
    }

    try {
      const body = await readJsonBody(req);
      const api = req.query && req.query.api;

      if (api === "save") {
        const result = await saveChanges(req, user, body);
        sendJson(res, 200, result);
        return;
      }

      res.sendStatus(404);
    } catch (error) {
      obj.debug("plugin:ssbconfig", "handleAdminPostReq error", error);
      sendJson(res, 500, { error: error.message || "Unexpected error" });
    }
  };

  // Validates and commits file changes to GitHub when there are no validation errors.
  async function saveChanges(req, user, body) {
    const prepared = await configService.prepareSave(req, user, body);

    if (prepared.validationErrors.length > 0) {
      return {
        ok: false,
        branch: prepared.branch,
        domainId: prepared.domainId,
        changedFiles: prepared.fileChanges.map((f) => f.path),
        validationErrors: prepared.validationErrors,
        error: "Validation failed. Fix schema errors before saving."
      };
    }

    const result = await githubCommitFiles(
      prepared.settings,
      {
        owner: prepared.settings.configRepoOwner,
        repo: prepared.settings.configRepoName,
        branch: prepared.branch
      },
      prepared.fileChanges,
      prepared.commitMessage,
      (user && user.name) ? user.name : "MeshCentral Admin"
    );

    // Group sync runs only after the GitHub commit succeeds, so repo is source-of-truth.
    const groupSync = await meshcentralService.syncCreatedImageconfigGroups(prepared.domainId, prepared.createdImageconfigs, user);

    return {
      ok: true,
      branch: prepared.branch,
      domainId: prepared.domainId,
      changedFiles: prepared.fileChanges.map((f) => f.path),
      validationErrors: [],
      commitSha: result.commitSha,
      groupSync
    };
  }

  // Sends JSON responses with status code and proper content-type header.
  function sendJson(res, statusCode, payload) {
    res.status(statusCode);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify(payload));
  }

  // Reads and parses JSON request bodies from incoming POST streams.
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  return obj;
};
