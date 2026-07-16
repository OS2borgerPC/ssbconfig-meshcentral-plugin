"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("yaml");
const Ajv = require("ajv");

function createConfigService(options) {
  const meshServer = options.meshServer;
  const pluginDir = options.pluginDir;
  const github = options.github;

  function getPluginConfig() {
    const runtimeConfig =
      meshServer &&
      meshServer.config &&
      meshServer.config.settings &&
      meshServer.config.settings.plugins &&
      meshServer.config.settings.plugins.ssbconfig;

    let diskConfig = null;
    try {
      const configPath = path.resolve(pluginDir, "..", "..", "config.json");
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

  function resolveRequestDomainId(req, user) {
    const domains = (meshServer && meshServer.config && meshServer.config.domains) || {};
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

  function getDomainSegment(domainId) {
    const raw = String(domainId || "").trim();
    return raw.length > 0 ? raw : "default";
  }

  function normalizePath(input) {
    return String(input || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
  }

  function joinRepoPath() {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) {
      const part = normalizePath(arguments[i]);
      if (part) parts.push(part);
    }
    return parts.join("/");
  }

  function isConfigFilePath(filePath) {
    const low = String(filePath || "").toLowerCase();
    return low.endsWith(".yml") || low.endsWith(".yaml") || low.endsWith(".json");
  }

  function parseConfigFile(filePath, raw) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".json") return JSON.parse(raw);
    return yaml.parse(raw);
  }

  function stringifyConfigFile(filePath, value) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".json") return JSON.stringify(value || {}, null, 2) + "\n";
    return yaml.stringify(value || {});
  }

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

  async function listConfigFiles(settings, branch, dirPath) {
    const listing = await github.githubGetDirectory(settings, settings.configRepoOwner, settings.configRepoName, dirPath, branch);
    const files = listing.filter((item) => item && item.type === "file" && isConfigFilePath(item.path));
    const result = [];

    for (const file of files) {
      const loaded = await github.githubGetFileContent(settings, settings.configRepoOwner, settings.configRepoName, file.path, branch);
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

  async function listConfigFilePaths(settings, branch, dirPath) {
    const listing = await github.githubGetDirectory(settings, settings.configRepoOwner, settings.configRepoName, dirPath, branch);
    return listing
      .filter((item) => item && item.type === "file" && isConfigFilePath(item.path))
      .map((item) => normalizePath(item.path));
  }

  function extractPolicyDisplayName(entry) {
    if (!entry || typeof entry !== "object") return "";
    const data = entry.data && typeof entry.data === "object" ? entry.data : {};
    if (typeof data.name === "string" && data.name.trim().length > 0) return data.name.trim();
    if (typeof data.title === "string" && data.title.trim().length > 0) return data.title.trim();
    return path.basename(entry.path || "");
  }

  function extractImageconfigGroupName(filePath, content) {
    const data = (content && typeof content === "object") ? content : {};
    if (typeof data.name === "string" && data.name.trim().length > 0) return data.name.trim();
    if (typeof data.title === "string" && data.title.trim().length > 0) return data.title.trim();
    return path.basename(filePath || "imageconfig").replace(/\.[^.]+$/, "");
  }

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

  async function getSchemasAndUi(settings, branch) {
    const policySchemaRaw = await github.githubGetFileContent(
      settings,
      settings.schemaRepoOwner,
      settings.schemaRepoName,
      settings.policiesSchemaPath,
      branch
    );
    const policyUiRaw = await github.githubGetFileContent(
      settings,
      settings.schemaRepoOwner,
      settings.schemaRepoName,
      settings.policiesUiSchemaPath,
      branch
    );
    const imageSchemaRaw = await github.githubGetFileContent(
      settings,
      settings.schemaRepoOwner,
      settings.schemaRepoName,
      settings.imageconfigsSchemaPath,
      branch
    );
    const imageUiRaw = await github.githubGetFileContent(
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

  async function getBootstrapPayload(req, user) {
    const settings = getPluginSettings();
    ensureSettings(settings);

    const branch = settings.targetBranch || await github.githubGetDefaultBranch(settings, settings.configRepoOwner, settings.configRepoName);
    const loadedSha = await github.githubGetBranchHeadSha(settings, settings.configRepoOwner, settings.configRepoName, branch);
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

  function createValidator(schema) {
    const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
    return ajv.compile(schema);
  }

  function formatAjvErrors(errors) {
    return (errors || []).map((err) => ({
      path: err.instancePath || "/",
      message: err.message || "invalid value",
      text: `${err.instancePath || "/"}: ${err.message || "invalid value"}`
    }));
  }

  function ensurePathUnder(baseDir, filePath, label) {
    const base = normalizePath(baseDir);
    const target = normalizePath(filePath);
    if (!base || !target || !(target === base || target.startsWith(base + "/"))) {
      throw new Error(`Invalid ${label} path: ${filePath}`);
    }
    return target;
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function isPrefixOnlyPlaceholderPath(value) {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    return trimmed === "/assets" ||
      trimmed === "/assets/" ||
      trimmed === "../policies" ||
      trimmed === "../policies/";
  }

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

  async function prepareSave(req, user, body) {
    const settings = getPluginSettings();
    ensureSettings(settings);

    const branch = settings.targetBranch || await github.githubGetDefaultBranch(settings, settings.configRepoOwner, settings.configRepoName);
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

  return {
    resolveRequestDomainId,
    getBootstrapPayload,
    prepareSave
  };
}

module.exports = {
  createConfigService
};
