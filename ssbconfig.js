"use strict";

const https = require("https");
const path = require("path");

let yaml = null;
try {
  yaml = require("yaml");
} catch (e) {
  // YAML parsing is optional when config is JSON.
}

module.exports.ssbconfig = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  obj.debug = obj.meshServer.debug;
  obj.VIEWS = __dirname + "/views/";

  obj.server_startup = function () {
    obj.debug("plugin:ssbconfig", "starting plugin");
  };

  obj.handleAdminReq = async function (req, res, user) {
    if (!user || !user.siteadmin) {
      res.status(403).send("Forbidden");
      return;
    }

    try {
      if (req.query.api === "bootstrap") {
        const payload = await getBootstrapPayload();
        sendJson(res, 200, payload);
        return;
      }

      if (req.method === "POST" && req.query.api === "save") {
        const body = await readJsonBody(req);
        const result = await saveAllChanges(body, user);
        sendJson(res, 200, result);
        return;
      }

      const vars = {
        pluginName: "Sikker Selvbetjening Config Editor",
        meshDomainsJson: JSON.stringify(getMeshDomainNames())
      };
      res.render(obj.VIEWS + "admin", vars);
    } catch (error) {
      obj.debug("plugin:ssbconfig", "handleAdminReq error", error);
      sendJson(res, 500, { error: error.message || "Unexpected error" });
    }
  };

  function getMeshDomainNames() {
    const domains = (obj.meshServer && obj.meshServer.config && obj.meshServer.config.domains) || {};
    return Object.keys(domains);
  }

  function getPluginSettings() {
    const fromConfig =
      (obj.meshServer &&
        obj.meshServer.config &&
        obj.meshServer.config.settings &&
        obj.meshServer.config.settings.plugins &&
        obj.meshServer.config.settings.plugins.ssbconfig) ||
      {};

    return {
      githubToken: fromConfig.githubToken || process.env.GITHUB_TOKEN,
      configRepoOwner: fromConfig.configRepoOwner || process.env.GITHUB_OWNER || "os2borgerpc",
      configRepoName: fromConfig.configRepoName || process.env.GITHUB_REPO || "sikker-selvbetjening-config",
      configFilePath: fromConfig.configFilePath || "config/config.json",
      schemaRepoOwner: fromConfig.schemaRepoOwner || process.env.SSB_SCHEMA_GITHUB_OWNER || "os2borgerpc",
      schemaRepoName: fromConfig.schemaRepoName || process.env.SSB_SCHEMA_GITHUB_REPO || "sikker-selvbetjening",
      schemaPath:
        fromConfig.schemaPath ||
        "schemas/system_files/usr/share/sikker-selvbetjening/schemas/schema.json",
      uiSchemaPath:
        fromConfig.uiSchemaPath ||
        "schemas/system_files/usr/share/sikker-selvbetjening/schemas/uischema.json",
      targetBranch: fromConfig.targetBranch || null
    };
  }

  async function getBootstrapPayload() {
    const settings = getPluginSettings();
    ensureSettings(settings);

    const configContent = await githubGetFileContent(
      settings,
      settings.configRepoOwner,
      settings.configRepoName,
      settings.configFilePath
    );

    const schemaContent = await githubGetFileContent(
      settings,
      settings.schemaRepoOwner,
      settings.schemaRepoName,
      settings.schemaPath
    );

    const uiSchemaContent = await githubGetFileContent(
      settings,
      settings.schemaRepoOwner,
      settings.schemaRepoName,
      settings.uiSchemaPath
    );

    return {
      configData: parseConfigByPath(settings.configFilePath, configContent.content),
      schema: JSON.parse(schemaContent.content),
      uischema: JSON.parse(uiSchemaContent.content),
      configRepo: {
        owner: settings.configRepoOwner,
        repo: settings.configRepoName,
        filePath: settings.configFilePath,
        branch: configContent.branch
      },
      meshDomains: getMeshDomainNames(),
      configFileSha: configContent.sha
    };
  }

  async function saveAllChanges(body, user) {
    const settings = getPluginSettings();
    ensureSettings(settings);

    const configData = body && body.configData;
    const domainMap = (body && body.domainMap) || {};
    const assets = (body && body.assets) || [];

    if (!configData || typeof configData !== "object") {
      throw new Error("configData must be an object");
    }

    if (!Array.isArray(assets)) {
      throw new Error("assets must be an array");
    }

    const meshDomains = getMeshDomainNames();
    const transformedConfig = applyDomainMap(configData, domainMap, meshDomains);
    const configContent = stringifyConfigByPath(settings.configFilePath, transformedConfig);

    const defaultBranch = await githubGetDefaultBranch(
      settings,
      settings.configRepoOwner,
      settings.configRepoName
    );
    const branch = settings.targetBranch || defaultBranch;

    const commitMessage =
      (body && body.commitMessage) ||
      "Update config and assets from MeshCentral plugin";

    const assetDomain =
      body && typeof body.assetDomain === "string" ? body.assetDomain.trim() : "";

    if (assets.length > 0 && !assetDomain) {
      throw new Error("assetDomain is required when uploading assets");
    }

    if (assetDomain && meshDomains.indexOf(assetDomain) === -1) {
      throw new Error("assetDomain must be a valid MeshCentral domain");
    }

    const fileChanges = [
      {
        path: settings.configFilePath,
        contentUtf8: configContent
      }
    ];

    for (const asset of assets) {
      if (!asset || typeof asset.path !== "string" || typeof asset.contentBase64 !== "string") {
        throw new Error("Each asset must include path and contentBase64");
      }

      const safeAssetPath = sanitizeAssetPath(asset.path);
      const repoAssetPath = joinRepoPath(joinRepoPath("assets", assetDomain), safeAssetPath);
      const assetUtf8 = Buffer.from(asset.contentBase64, "base64").toString("base64");
      fileChanges.push({
        path: repoAssetPath,
        contentBase64: assetUtf8,
        isBase64: true
      });
    }

    const commitResult = await githubCommitFiles(
      settings,
      {
        owner: settings.configRepoOwner,
        repo: settings.configRepoName,
        branch
      },
      fileChanges,
      commitMessage,
      user && user.name ? user.name : "MeshCentral Admin"
    );

    return {
      ok: true,
      commitSha: commitResult.commitSha,
      branch,
      changedFiles: fileChanges.map((f) => f.path)
    };
  }

  function applyDomainMap(configData, domainMap, meshDomains) {
    const clone = JSON.parse(JSON.stringify(configData));

    if (!clone.domains || typeof clone.domains !== "object" || Array.isArray(clone.domains)) {
      return clone;
    }

    const sourceDomains = clone.domains;
    const mappedDomains = {};

    for (const meshDomain of meshDomains) {
      const sourceDomain = domainMap[meshDomain];
      if (sourceDomain && Object.prototype.hasOwnProperty.call(sourceDomains, sourceDomain)) {
        mappedDomains[meshDomain] = sourceDomains[sourceDomain];
      }
    }

    for (const key of Object.keys(sourceDomains)) {
      if (!Object.prototype.hasOwnProperty.call(mappedDomains, key)) {
        mappedDomains[key] = sourceDomains[key];
      }
    }

    clone.domains = mappedDomains;
    return clone;
  }

  function parseConfigByPath(configPath, content) {
    const ext = path.extname(configPath).toLowerCase();
    if (ext === ".json") {
      return JSON.parse(content);
    }

    if ((ext === ".yaml" || ext === ".yml") && yaml) {
      return yaml.parse(content);
    }

    throw new Error("Unsupported config format. Use .json, or install yaml dependency for .yml/.yaml");
  }

  function stringifyConfigByPath(configPath, data) {
    const ext = path.extname(configPath).toLowerCase();
    if (ext === ".json") {
      return JSON.stringify(data, null, 2) + "\n";
    }

    if ((ext === ".yaml" || ext === ".yml") && yaml) {
      return yaml.stringify(data);
    }

    throw new Error("Unsupported config format. Use .json, or install yaml dependency for .yml/.yaml");
  }

  function sanitizeAssetPath(assetPath) {
    const normalized = normalizePath(assetPath);
    if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error("Asset path is invalid");
    }
    return normalized;
  }

  function normalizePath(input) {
    return String(input || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
  }

  function joinRepoPath(basePath, subPath) {
    const base = normalizePath(basePath);
    const sub = normalizePath(subPath);
    return base ? base + "/" + sub : sub;
  }

  function ensureSettings(settings) {
    if (!settings.githubToken) {
      throw new Error("Missing GitHub token. Set plugins.ssbconfig.githubToken or GITHUB_TOKEN env var.");
    }
  }

  function sendJson(res, statusCode, payload) {
    res.status(statusCode);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify(payload));
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  async function githubGetDefaultBranch(settings, owner, repo) {
    const repoInfo = await githubRequest(settings, "GET", `/repos/${owner}/${repo}`);
    return repoInfo.default_branch;
  }

  async function githubGetFileContent(settings, owner, repo, filePath) {
    const branch = settings.targetBranch || (await githubGetDefaultBranch(settings, owner, repo));
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
    return { content, sha: response.sha, branch };
  }

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
      const blob = await githubRequest(
        settings,
        "POST",
        `/repos/${repoRef.owner}/${repoRef.repo}/git/blobs`,
        {
          content: change.isBase64 ? change.contentBase64 : Buffer.from(change.contentUtf8, "utf8").toString("base64"),
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
      const req = https.request(options, (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode || 500;
          const json = raw ? safeJsonParse(raw) : {};
          if (status >= 200 && status < 300) {
            resolve(json);
            return;
          }

          const message =
            (json && json.message) ||
            `GitHub API call failed (${method} ${apiPath}) with status ${status}`;
          reject(new Error(message));
        });
      });

      req.on("error", reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  function safeJsonParse(input) {
    try {
      return JSON.parse(input);
    } catch (e) {
      return { raw: input };
    }
  }

  return obj;
};
