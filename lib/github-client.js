"use strict";

const https = require("https");

function normalizePath(input) {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

async function githubGetDefaultBranch(settings, owner, repo) {
  const info = await githubRequest(settings, "GET", `/repos/${owner}/${repo}`);
  return info.default_branch;
}

async function githubGetBranchHeadSha(settings, owner, repo, branch) {
  const ref = await githubRequest(
    settings,
    "GET",
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
  );
  return (ref && ref.object && typeof ref.object.sha === "string") ? ref.object.sha : "";
}

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

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { raw };
  }
}

module.exports = {
  githubGetDefaultBranch,
  githubGetBranchHeadSha,
  githubGetDirectory,
  githubGetFileContent,
  githubCommitFiles
};
