"use strict";

const fs = require("fs");
const https = require("https");
const path = require("path");
const crypto = require("crypto");
const util = require("util");
const yaml = require("yaml");
const Ajv = require("ajv");

module.exports.ssbconfig = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  obj.debug = obj.meshServer.debug;
  obj.VIEWS = __dirname + "/views/";

  // Logs plugin startup for operational visibility in MeshCentral logs.
  obj.server_startup = function () {
    obj.debug("plugin:ssbconfig", "plugin started!!!");
    ensureOs2UserGroupOnStartup();
  };

  function ensureOs2UserGroupOnStartup() {
    const meshServer = obj.meshServer;
    const db = meshServer && meshServer.db;
    if (!db || typeof db.Set !== "function") {
      obj.debug("plugin:ssbconfig", "OS2 init: MeshCentral DB API unavailable; cannot create user group.");
      return;
    }

    const domains = (meshServer.config && meshServer.config.domains && typeof meshServer.config.domains === "object")
      ? Object.keys(meshServer.config.domains)
      : [];
    if (domains.indexOf("") < 0) domains.unshift("");

    const groups = (meshServer.userGroups && typeof meshServer.userGroups === "object") ? meshServer.userGroups : {};
    if (!meshServer.userGroups || typeof meshServer.userGroups !== "object") {
      meshServer.userGroups = {};
    }

    for (const domainId of domains) {
      const exists = Object.values(groups).some((group) => {
        return group && typeof group === "object" && group.domain === domainId && String(group.name || "") === "OS2";
      });
      if (exists) continue;

      const groupId = `ugrp/${domainId}/${crypto.randomBytes(9).toString("base64").replace(/\+/g, "@").replace(/\//g, "$")}`;
      const userGroup = {
        _id: groupId,
        type: "ugrp",
        domain: domainId,
        name: "OS2",
        creation: Date.now(),
        links: {}
      };

      db.Set(userGroup);
      meshServer.userGroups[groupId] = userGroup;
      obj.debug("plugin:ssbconfig", `OS2 init: created user group in domain \"${domainId || "default"}\".`);
    }
  }

  // Handles admin GET routes: bundle asset serving, bootstrap payload, and main admin view.
  obj.handleAdminReq = async function (req, res, user) {
    if (!user || !user.siteadmin) {
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
        const payload = await getBootstrapPayload(req, user);
        sendJson(res, 200, payload);
        return;
      }

      res.render(obj.VIEWS + "admin", {
        pluginName: "Sikker Selvbetjening Config Editor",
        domainId: resolveRequestDomainId(req, user)
      });
    } catch (error) {
      obj.debug("plugin:ssbconfig", "handleAdminReq error", error);
      sendJson(res, 500, { error: error.message || "Unexpected error" });
    }
  };

  // Handles admin POST routes for preview validation and save/commit operations.
  obj.handleAdminPostReq = async function (req, res, user) {
    if (!user || !user.siteadmin) {
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

  // Merges plugin settings from disk config and runtime config sources.
  function getPluginConfig() {
    const runtimeConfig =
      obj.meshServer &&
      obj.meshServer.config &&
      obj.meshServer.config.settings &&
      obj.meshServer.config.settings.plugins &&
      obj.meshServer.config.settings.plugins.ssbconfig;

    let diskConfig = null;
    try {
      const configPath = path.resolve(__dirname, "..", "..", "config.json");
      if (fs.existsSync(configPath)) {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
        diskConfig =
          parsed &&
          parsed.settings &&
          parsed.settings.plugins &&
          parsed.settings.plugins.ssbconfig;
      }
    } catch (e) {
      // Ignore disk config parse errors and use runtime config.
    }

    return Object.assign(
      {},
      (diskConfig && typeof diskConfig === "object") ? diskConfig : {},
      (runtimeConfig && typeof runtimeConfig === "object") ? runtimeConfig : {}
    );
  }

  // Normalizes and returns all ssbconfig settings consumed by the plugin.
  function getPluginSettings() {
    const cfg = getPluginConfig();

    return {
      githubToken: (cfg.githubToken || process.env.GITHUB_TOKEN || "").trim(),
      configRepoOwner: cfg.configRepoOwner || process.env.GITHUB_OWNER || "",
      configRepoName: cfg.configRepoName || process.env.GITHUB_REPO || "",
      schemaRepoOwner: cfg.schemaRepoOwner || process.env.SSB_SCHEMA_GITHUB_OWNER || "",
      schemaRepoName: cfg.schemaRepoName || process.env.SSB_SCHEMA_GITHUB_REPO || "",
      configsDir: normalizePath(cfg.configsDir || "config"),
      policiesDir: normalizePath(cfg.policiesDir || "policies"),
      imageconfigsDir: normalizePath(cfg.imageconfigsDir || "imageconfigs"),
      assetsDir: normalizePath(cfg.assetsDir || "assets"),
      policiesSchemaPath: normalizePath(cfg.policiesSchemaPath || ""),
      policiesUiSchemaPath: normalizePath(cfg.policiesUiSchemaPath || ""),
      imageconfigsSchemaPath: normalizePath(cfg.imageconfigsSchemaPath || ""),
      imageconfigsUiSchemaPath: normalizePath(cfg.imageconfigsUiSchemaPath || ""),
      targetBranch: (cfg.targetBranch || "").trim() || null
    };
  }

  // Validates required settings before any GitHub interactions are attempted.
  function ensureSettings(settings) {
    if (!settings.githubToken) {
      throw new Error("Missing GitHub token. Set settings.plugins.ssbconfig.githubToken or GITHUB_TOKEN.");
    }
    if (!settings.configRepoOwner || !settings.configRepoName) {
      throw new Error("Missing configRepoOwner/configRepoName for ssbconfig.");
    }
    if (!settings.schemaRepoOwner || !settings.schemaRepoName) {
      throw new Error("Missing schemaRepoOwner/schemaRepoName for ssbconfig.");
    }
  }

  // Resolves current MeshCentral domain from request path or user context.
  function resolveRequestDomainId(req, user) {
    const domains = (obj.meshServer && obj.meshServer.config && obj.meshServer.config.domains) || {};
    const knownDomains = Object.keys(domains);

    if (req && typeof req.url === "string") {
      const pathOnly = req.url.split("?")[0] || "";
      const parts = pathOnly.split("/").filter((x) => x.length > 0);
      if (parts.length > 1 && parts[1] === "pluginadmin.ashx" && knownDomains.indexOf(parts[0]) >= 0) {
        return parts[0];
      }
    }

    return (user && typeof user.domain === "string") ? user.domain : "";
  }

  // Maps empty MeshCentral domain to "default" for GitHub directory naming.
  function getDomainSegment(domainId) {
    const raw = String(domainId || "").trim();
    return raw.length > 0 ? raw : "default";
  }

  // Produces a normalized slash-separated relative path.
  function normalizePath(input) {
    return String(input || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
  }

  // Safely joins multiple path fragments into a normalized repo path.
  function joinRepoPath() {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) {
      const part = normalizePath(arguments[i]);
      if (part) parts.push(part);
    }
    return parts.join("/");
  }

  // Filters repository files down to supported config file extensions.
  function isConfigFilePath(filePath) {
    const low = String(filePath || "").toLowerCase();
    return low.endsWith(".yml") || low.endsWith(".yaml") || low.endsWith(".json");
  }

  // Parses config content based on file extension (.json or YAML).
  function parseConfigFile(filePath, raw) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".json") return JSON.parse(raw);
    return yaml.parse(raw);
  }

  // Serializes config objects back to JSON or YAML by target file extension.
  function stringifyConfigFile(filePath, value) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".json") return JSON.stringify(value || {}, null, 2) + "\n";
    return yaml.stringify(value || {});
  }

  // Builds domain-specific GitHub directories for policies, imageconfigs, and assets.
  function getDomainPaths(settings, domainId) {
    const domainSegment = getDomainSegment(domainId);
    const domainBase = joinRepoPath(settings.configsDir, domainSegment);
    return {
      domainBase,
      policiesPath: joinRepoPath(domainBase, settings.policiesDir),
      imageconfigsPath: joinRepoPath(domainBase, settings.imageconfigsDir),
      assetsPath: joinRepoPath(domainBase, settings.assetsDir)
    };
  }

  // Lists and parses all config files under a repository directory.
  async function listConfigFiles(settings, branch, dirPath) {
    const listing = await githubGetDirectory(settings, settings.configRepoOwner, settings.configRepoName, dirPath, branch);
    const files = listing.filter((item) => item && item.type === "file" && isConfigFilePath(item.path));
    const result = [];

    for (const file of files) {
      const loaded = await githubGetFileContent(settings, settings.configRepoOwner, settings.configRepoName, file.path, branch);
      let parsed = {};
      try {
        parsed = parseConfigFile(file.path, loaded.content);
      } catch (e) {
        parsed = {};
      }

      result.push({
        path: file.path,
        sha: loaded.sha,
        data: (parsed && typeof parsed === "object") ? parsed : {},
        name: path.basename(file.path)
      });
    }

    result.sort((a, b) => a.path.localeCompare(b.path));
    return result;
  }

  // Lists config file paths under a directory without parsing file contents.
  async function listConfigFilePaths(settings, branch, dirPath) {
    const listing = await githubGetDirectory(settings, settings.configRepoOwner, settings.configRepoName, dirPath, branch);
    return listing
      .filter((item) => item && item.type === "file" && isConfigFilePath(item.path))
      .map((item) => normalizePath(item.path));
  }

  // Chooses a human-friendly policy display name from file content.
  function extractPolicyDisplayName(entry) {
    if (!entry || typeof entry !== "object") return "";
    const data = entry.data && typeof entry.data === "object" ? entry.data : {};
    if (typeof data.name === "string" && data.name.trim().length > 0) return data.name.trim();
    if (typeof data.title === "string" && data.title.trim().length > 0) return data.title.trim();
    return path.basename(entry.path || "");
  }

  // Chooses a device group name for imageconfig-derived MeshCentral groups.
  function extractImageconfigGroupName(filePath, content) {
    const data = (content && typeof content === "object") ? content : {};
    if (typeof data.name === "string" && data.name.trim().length > 0) return data.name.trim();
    if (typeof data.title === "string" && data.title.trim().length > 0) return data.title.trim();
    return path.basename(filePath || "imageconfig").replace(/\.[^.]+$/, "");
  }

  // Extracts image_id from imageconfig payload using common key variations.
  function extractImageId(content) {
    const data = (content && typeof content === "object") ? content : {};
    const candidates = [data.image_id, data.imageId, data.imageID];
    for (const value of candidates) {
      if (value !== null && value !== undefined) {
        const text = String(value).trim();
        if (text.length > 0) return text;
      }
    }
    return "";
  }

  // Downloads and parses both schema and uiSchema documents for policies and imageconfigs.
  async function getSchemasAndUi(settings, branch) {
    const policySchemaRaw = await githubGetFileContent(
      settings,
      settings.schemaRepoOwner,
      settings.schemaRepoName,
      settings.policiesSchemaPath,
      branch
    );
    const policyUiRaw = await githubGetFileContent(
      settings,
      settings.schemaRepoOwner,
      settings.schemaRepoName,
      settings.policiesUiSchemaPath,
      branch
    );
    const imageSchemaRaw = await githubGetFileContent(
      settings,
      settings.schemaRepoOwner,
      settings.schemaRepoName,
      settings.imageconfigsSchemaPath,
      branch
    );
    const imageUiRaw = await githubGetFileContent(
      settings,
      settings.schemaRepoOwner,
      settings.schemaRepoName,
      settings.imageconfigsUiSchemaPath,
      branch
    );

    return {
      policiesSchema: JSON.parse(policySchemaRaw.content),
      policiesUiSchema: JSON.parse(policyUiRaw.content),
      imageconfigsSchema: JSON.parse(imageSchemaRaw.content),
      imageconfigsUiSchema: JSON.parse(imageUiRaw.content)
    };
  }

  // Builds initial admin payload with domain paths, files, and schema documents.
  async function getBootstrapPayload(req, user) {
    const settings = getPluginSettings();
    ensureSettings(settings);

    const branch = settings.targetBranch || await githubGetDefaultBranch(settings, settings.configRepoOwner, settings.configRepoName);
    const loadedSha = await githubGetBranchHeadSha(settings, settings.configRepoOwner, settings.configRepoName, branch);
    const domainId = resolveRequestDomainId(req, user);
    const domainPaths = getDomainPaths(settings, domainId);

    const [schemas, policies, imageconfigs] = await Promise.all([
      getSchemasAndUi(settings, branch),
      listConfigFiles(settings, branch, domainPaths.policiesPath),
      listConfigFiles(settings, branch, domainPaths.imageconfigsPath)
    ]);

    return {
      domainId,
      branch,
      loadedSha,
      configRepo: {
        owner: settings.configRepoOwner,
        repo: settings.configRepoName
      },
      domainPaths,
      policies: policies.map((p) => ({
        path: p.path,
        sha: p.sha,
        content: p.data,
        displayName: extractPolicyDisplayName(p)
      })),
      imageconfigs: imageconfigs.map((f) => ({
        path: f.path,
        sha: f.sha,
        content: f.data,
        displayName: path.basename(f.path)
      })),
      schemas
    };
  }

  // Creates an Ajv validator instance for a given JSON schema.
  function createValidator(schema) {
    const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
    return ajv.compile(schema);
  }

  // Converts Ajv validation errors into a frontend-friendly structure.
  function formatAjvErrors(errors) {
    return (errors || []).map((err) => ({
      path: err.instancePath || "/",
      message: err.message || "invalid value",
      text: `${err.instancePath || "/"}: ${err.message || "invalid value"}`
    }));
  }

  // Ensures provided path stays within the expected domain-specific base directory.
  function ensurePathUnder(baseDir, filePath, label) {
    const base = normalizePath(baseDir);
    const target = normalizePath(filePath);
    if (!base || !target || !(target === base || target.startsWith(base + "/"))) {
      throw new Error(`Invalid ${label} path: ${filePath}`);
    }
    return target;
  }

  // Normalizes unknown list-like inputs to arrays.
  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  // Treats template prefixes without actual filenames as empty optional values.
  function isPrefixOnlyPlaceholderPath(value) {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    return trimmed === "/assets" ||
      trimmed === "/assets/" ||
      trimmed === "../policies" ||
      trimmed === "../policies/";
  }

  // Recursively strips empty values so optional blank fields are not validated or saved.
  function sanitizeForConfig(value) {
    if (value === null || value === undefined) {
      return undefined;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0) return undefined;
      if (isPrefixOnlyPlaceholderPath(trimmed)) return undefined;
      return value;
    }

    if (Array.isArray(value)) {
      const next = [];
      for (const item of value) {
        const sanitized = sanitizeForConfig(item);
        if (sanitized !== undefined) {
          next.push(sanitized);
        }
      }
      return next.length > 0 ? next : undefined;
    }

    if (typeof value === "object") {
      const next = {};
      for (const key of Object.keys(value)) {
        const sanitized = sanitizeForConfig(value[key]);
        if (sanitized !== undefined) {
          next[key] = sanitized;
        }
      }
      return Object.keys(next).length > 0 ? next : undefined;
    }

    return value;
  }

  // Prepares and validates incoming save payload and computes GitHub file changes.
  async function prepareSave(req, user, body) {
    const settings = getPluginSettings();
    ensureSettings(settings);

    const branch = settings.targetBranch || await githubGetDefaultBranch(settings, settings.configRepoOwner, settings.configRepoName);
    const domainId = resolveRequestDomainId(req, user);
    const domainPaths = getDomainPaths(settings, domainId);

    const schemas = await getSchemasAndUi(settings, branch);
    const [existingPolicyPaths, existingImageconfigPaths] = await Promise.all([
      listConfigFilePaths(settings, branch, domainPaths.policiesPath),
      listConfigFilePaths(settings, branch, domainPaths.imageconfigsPath)
    ]);
    const policyValidate = createValidator(schemas.policiesSchema);
    const imageValidate = createValidator(schemas.imageconfigsSchema);

    const policies = toArray(body && body.policies);
    const imageconfigs = toArray(body && body.imageconfigs);
    const assets = toArray(body && body.assets);

    const validationErrors = [];
    const fileChanges = [];
    const createdImageconfigs = [];
    const submittedPolicyPaths = new Set();
    const submittedImageconfigPaths = new Set();

    for (const file of policies) {
      if (!file || typeof file.path !== "string") continue;
      const safePath = ensurePathUnder(domainPaths.policiesPath, file.path, "policy");
      submittedPolicyPaths.add(safePath);
      const sourceContent = (file.content && typeof file.content === "object") ? file.content : {};
      const sanitizedContent = sanitizeForConfig(sourceContent);
      const content = (sanitizedContent && typeof sanitizedContent === "object") ? sanitizedContent : {};

      const valid = policyValidate(content);
      if (!valid) {
        validationErrors.push({
          type: "policies",
          path: safePath,
          errors: formatAjvErrors(policyValidate.errors)
        });
      }

      fileChanges.push({
        path: safePath,
        contentUtf8: stringifyConfigFile(safePath, content)
      });
    }

    for (const file of imageconfigs) {
      if (!file || typeof file.path !== "string") continue;
      const safePath = ensurePathUnder(domainPaths.imageconfigsPath, file.path, "imageconfig");
      submittedImageconfigPaths.add(safePath);
      // Existing files include a sha from bootstrap; empty sha means this entry is newly created.
      const incomingSha = (typeof file.sha === "string") ? file.sha.trim() : "";
      const sourceContent = (file.content && typeof file.content === "object") ? file.content : {};
      const sanitizedContent = sanitizeForConfig(sourceContent);
      const content = (sanitizedContent && typeof sanitizedContent === "object") ? sanitizedContent : {};

      const valid = imageValidate(content);
      if (!valid) {
        validationErrors.push({
          type: "imageconfigs",
          path: safePath,
          errors: formatAjvErrors(imageValidate.errors)
        });
      }

      fileChanges.push({
        path: safePath,
        contentUtf8: stringifyConfigFile(safePath, content)
      });

      // Only brand-new imageconfigs trigger automatic MeshCentral device-group sync.
      if (!incomingSha) {
        createdImageconfigs.push({
          path: safePath,
          groupName: extractImageconfigGroupName(safePath, content),
          imageId: extractImageId(content)
        });
      }
    }

    for (const existingPath of existingPolicyPaths) {
      if (!submittedPolicyPaths.has(existingPath)) {
        fileChanges.push({
          path: existingPath,
          delete: true
        });
      }
    }

    for (const existingPath of existingImageconfigPaths) {
      if (!submittedImageconfigPaths.has(existingPath)) {
        fileChanges.push({
          path: existingPath,
          delete: true
        });
      }
    }

    for (const asset of assets) {
      if (!asset || typeof asset.path !== "string" || typeof asset.content !== "string") continue;
      const safePath = ensurePathUnder(domainPaths.assetsPath, asset.path, "asset");
      fileChanges.push({
        path: safePath,
        contentBase64: asset.content,
        isBase64: true
      });
    }

    return {
      settings,
      branch,
      domainId,
      domainPaths,
      validationErrors,
      fileChanges,
      createdImageconfigs,
      commitMessage: (body && typeof body.commitMessage === "string" && body.commitMessage.trim())
        ? body.commitMessage.trim()
        : "Update domain config from MeshCentral"
    };
  }

  // Creates or updates a MeshCentral device group for each newly created imageconfig.
  function buildAdminMeshLinks(user) {
    const links = {};
    if (user && typeof user._id === "string" && user._id.length > 0) {
      links[user._id] = {
        name: (typeof user.name === "string" && user.name.trim().length > 0) ? user.name.trim() : "MeshCentral Admin",
        rights: 0xFFFFFFFF
      };
    }
    return links;
  }

  function ensureUserMeshLink(db, meshServer, user, meshId) {
    if (!user || typeof user._id !== "string" || !meshId) return false;

    // User.links keys are URL-encoded mesh IDs in MeshCentral's data model.
    user.links = (user.links && typeof user.links === "object") ? user.links : {};
    const encodedMeshId = encodeURIComponent(meshId);
    user.links[encodedMeshId] = {
      rights: 0xFFFFFFFF
    };
    db.Set(user);

    if (meshServer && meshServer.users && typeof meshServer.users === "object") {
      meshServer.users[user._id] = user;
    }
    return true;
  }

  async function syncCreatedImageconfigGroups(domainId, createdImageconfigs, user) {
    const outcome = {
      created: 0,
      updated: 0,
      warnings: []
    };

    const items = Array.isArray(createdImageconfigs) ? createdImageconfigs : [];
    obj.debug("plugin:ssbconfig", `group sync start: domain=${domainId || "default"}, items=${items.length}`);
    if (items.length === 0) return outcome;

    const meshServer = obj.meshServer;
    const db = meshServer && meshServer.db;
    if (!db || typeof db.Set !== "function") {
      outcome.warnings.push("MeshCentral DB API unavailable; skipped device-group sync.");
      obj.debug("plugin:ssbconfig", "group sync skipped: MeshCentral DB API unavailable");
      return outcome;
    }

    const meshes = (meshServer && meshServer.meshes && typeof meshServer.meshes === "object") ? meshServer.meshes : {};
    const adminLinks = buildAdminMeshLinks(user);
    const creatorId = (user && typeof user._id === "string") ? user._id : "";
    const creatorName = (user && typeof user.name === "string" && user.name.trim().length > 0) ? user.name.trim() : "MeshCentral Admin";
    obj.debug("plugin:ssbconfig", `group sync creator: id=${creatorId || "(empty)"}, name=${creatorName}`);

    for (const item of items) {
      const groupName = String(item && item.groupName ? item.groupName : "").trim();
      if (!groupName) {
        outcome.warnings.push(`Skipped group creation for ${item && item.path ? item.path : "imageconfig"}: missing name.`);
        obj.debug("plugin:ssbconfig", `group sync skip: missing groupName for ${item && item.path ? item.path : "imageconfig"}`);
        continue;
      }

      try {
        let existing = null;
        for (const mesh of Object.values(meshes)) {
          if (!mesh || typeof mesh !== "object") continue;
          if (mesh.domain === domainId && String(mesh.name || "") === groupName) {
            existing = mesh;
            break;
          }
        }

        const imageId = String(item && item.imageId ? item.imageId : "").trim();

        // Reuse an existing domain group with matching name to keep IDs stable.
        if (existing) {
          existing.links = (existing.links && typeof existing.links === "object") ? existing.links : {};
          Object.assign(existing.links, adminLinks);
          if (imageId) {
            existing.tags = (existing.tags && typeof existing.tags === "object") ? existing.tags : {};
            existing.tags.image_id = imageId;
            existing.image_id = imageId;
          }
          db.Set(existing);
          ensureUserMeshLink(db, meshServer, user, existing._id);
          outcome.updated += 1;
          obj.debug("plugin:ssbconfig", `group sync updated: domain=${domainId || "default"}, group=${groupName}, id=${existing._id || "unknown"}`);
          continue;
        }

        // Otherwise create a new mesh group and tag it with image_id when available.
        const meshId = `mesh/${domainId}/${crypto.randomBytes(9).toString("base64").replace(/\+/g, "@").replace(/\//g, "$")}`;
        const mesh = {
          _id: meshId,
          type: "mesh",
          mtype: 2,
          name: groupName,
          domain: domainId,
          links: { ...adminLinks },
          creation: Date.now(),
          creatorid: creatorId,
          creatorname: creatorName
        };

        if (imageId) {
          mesh.tags = { image_id: imageId };
          mesh.image_id = imageId;
        }

        db.Set(mesh);
        ensureUserMeshLink(db, meshServer, user, meshId);
        if (meshServer && meshServer.meshes && typeof meshServer.meshes === "object") {
          meshServer.meshes[meshId] = mesh;
        }

        outcome.created += 1;
        obj.debug("plugin:ssbconfig", `group sync created: domain=${domainId || "default"}, group=${groupName}, id=${meshId}`);
      } catch (error) {
        outcome.warnings.push(`Failed to sync device group for ${item && item.path ? item.path : "imageconfig"}: ${error.message || error}`);
        obj.debug("plugin:ssbconfig", "group sync failed", error);
      }
    }

    obj.debug("plugin:ssbconfig", `group sync done: created=${outcome.created}, updated=${outcome.updated}, warnings=${outcome.warnings.length}`);
    return outcome;
  }

  // Validates and commits file changes to GitHub when there are no validation errors.
  async function saveChanges(req, user, body) {
    const prepared = await prepareSave(req, user, body);

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
    const groupSync = await syncCreatedImageconfigGroups(prepared.domainId, prepared.createdImageconfigs, user);

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

  // Queries GitHub for a repository's default branch name.
  async function githubGetDefaultBranch(settings, owner, repo) {
    const info = await githubRequest(settings, "GET", `/repos/${owner}/${repo}`);
    return info.default_branch;
  }

  // Returns the current commit SHA at the tip of a repository branch.
  async function githubGetBranchHeadSha(settings, owner, repo, branch) {
    const ref = await githubRequest(
      settings,
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
    );
    return (ref && ref.object && typeof ref.object.sha === "string") ? ref.object.sha : "";
  }

  // Reads directory entries from GitHub and tolerates missing directories as empty.
  async function githubGetDirectory(settings, owner, repo, dirPath, branch) {
    const encodedPath = dirPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    try {
      const response = await githubRequest(
        settings,
        "GET",
        `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
      );

      return Array.isArray(response) ? response : [];
    } catch (error) {
      if (String(error.message || "").toLowerCase().includes("not found")) {
        return [];
      }
      throw error;
    }
  }

  // Downloads a single file from GitHub contents API and decodes base64 content.
  async function githubGetFileContent(settings, owner, repo, filePath, branch) {
    const encodedPath = filePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    const response = await githubRequest(
      settings,
      "GET",
      `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
    );

    const content = Buffer.from(response.content || "", "base64").toString("utf8");
    return {
      content,
      sha: response.sha
    };
  }

  // Creates blobs/tree/commit and updates branch ref to apply all file changes atomically.
  async function githubCommitFiles(settings, repoRef, fileChanges, commitMessage, actorName) {
    const ref = await githubRequest(
      settings,
      "GET",
      `/repos/${repoRef.owner}/${repoRef.repo}/git/ref/heads/${encodeURIComponent(repoRef.branch)}`
    );

    const latestCommitSha = ref.object.sha;
    const latestCommit = await githubRequest(
      settings,
      "GET",
      `/repos/${repoRef.owner}/${repoRef.repo}/git/commits/${latestCommitSha}`
    );

    const baseTreeSha = latestCommit.tree.sha;
    const treeEntries = [];

    for (const change of fileChanges) {
      if (change.delete === true) {
        treeEntries.push({
          path: normalizePath(change.path),
          mode: "100644",
          type: "blob",
          sha: null
        });
        continue;
      }

      const blob = await githubRequest(
        settings,
        "POST",
        `/repos/${repoRef.owner}/${repoRef.repo}/git/blobs`,
        {
          content: change.isBase64
            ? change.contentBase64
            : Buffer.from(change.contentUtf8 || "", "utf8").toString("base64"),
          encoding: "base64"
        }
      );

      treeEntries.push({
        path: normalizePath(change.path),
        mode: "100644",
        type: "blob",
        sha: blob.sha
      });
    }

    const newTree = await githubRequest(
      settings,
      "POST",
      `/repos/${repoRef.owner}/${repoRef.repo}/git/trees`,
      {
        base_tree: baseTreeSha,
        tree: treeEntries
      }
    );

    const newCommit = await githubRequest(
      settings,
      "POST",
      `/repos/${repoRef.owner}/${repoRef.repo}/git/commits`,
      {
        message: commitMessage,
        tree: newTree.sha,
        parents: [latestCommitSha],
        author: {
          name: actorName,
          email: "noreply@meshcentral.local"
        }
      }
    );

    await githubRequest(
      settings,
      "PATCH",
      `/repos/${repoRef.owner}/${repoRef.repo}/git/refs/heads/${encodeURIComponent(repoRef.branch)}`,
      {
        sha: newCommit.sha,
        force: false
      }
    );

    return { commitSha: newCommit.sha };
  }

  // Performs authenticated GitHub REST API requests and normalizes error handling.
  function githubRequest(settings, method, apiPath, body) {
    const options = {
      hostname: "api.github.com",
      path: apiPath,
      method,
      headers: {
        "User-Agent": "meshcentral-ssbconfig-plugin",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${settings.githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    };

    const payload = body ? JSON.stringify(body) : null;
    if (payload) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(payload);
    }

    return new Promise((resolve, reject) => {
      const request = https.request(options, (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode || 500;
          const parsed = raw ? safeJsonParse(raw) : {};

          if (status >= 200 && status < 300) {
            resolve(parsed);
            return;
          }

          const message = (parsed && parsed.message)
            ? parsed.message
            : `GitHub API failed (${method} ${apiPath}) with status ${status}`;
          reject(new Error(message));
        });
      });

      request.on("error", reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  // Safely parses JSON payloads and preserves raw text on parse failure.
  function safeJsonParse(raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return { raw };
    }
  }

  return obj;
};
