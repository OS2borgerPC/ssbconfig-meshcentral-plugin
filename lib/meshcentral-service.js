"use strict";

const crypto = require("crypto");

const MESH_RIGHTS_ADMIN = 0xFFFFFFFF;
// Helpdesk profile: remote control, terminal, files, wake, notes, remote view.
const MESH_RIGHTS_HELPDESK = 0x000001F8;
const DEVICE_GROUP_TYPE = 2;

function isPlainObject(value) {
  return value && (typeof value === "object") && !Array.isArray(value);
}

function getPluginConfig(meshServer) {
  const cfg = meshServer && meshServer.config && meshServer.config.settings && meshServer.config.settings.plugins && meshServer.config.settings.plugins.ssbconfig;
  return isPlainObject(cfg) ? cfg : {};
}

function toBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function parseList(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter((entry) => entry.length > 0)
    : [];
}

function compileRegex(pattern) {
  if (typeof pattern !== "string" || pattern.trim().length === 0) return null;
  try { return new RegExp(pattern); } catch (ex) { return null; }
}

function getMovePolicy(meshServer, domainId) {
  const cfg = getPluginConfig(meshServer);
  const rawRoot = isPlainObject(cfg.deviceMovePolicy) ? cfg.deviceMovePolicy : {};
  const perDomain = isPlainObject(rawRoot.domains) ? rawRoot.domains : {};
  const raw = isPlainObject(perDomain[domainId]) ? { ...rawRoot, ...perDomain[domainId] } : rawRoot;

  return {
    enabled: toBoolean(raw.enabled, true),
    requireOnline: toBoolean(raw.requireOnline, true),
    allowedSourceMeshIds: parseList(raw.allowedSourceMeshIds),
    allowedTargetMeshIds: parseList(raw.allowedTargetMeshIds),
    allowedSourceMeshNames: parseList(raw.allowedSourceMeshNames),
    allowedTargetMeshNames: parseList(raw.allowedTargetMeshNames),
    allowedSourceNameRegex: compileRegex(raw.allowedSourceNameRegex),
    allowedTargetNameRegex: compileRegex(raw.allowedTargetNameRegex)
  };
}

function meshMatchesPolicy(mesh, ids, names, nameRegex) {
  if (!mesh || typeof mesh !== "object") return false;
  const meshId = String(mesh._id || "");
  const meshName = String(mesh.name || "");

  if (ids.length > 0 && ids.indexOf(meshId) === -1) return false;
  if (names.length > 0 && names.indexOf(meshName) === -1) return false;
  if (nameRegex && !nameRegex.test(meshName)) return false;
  return true;
}

function normalizeNodeId(nodeId, domainId) {
  const value = String(nodeId || "").trim();
  if (value.length === 0) return "";
  if (value.indexOf("/") >= 0) return value;
  return `node/${domainId}/${value}`;
}

function isDeviceOnline(node) {
  if (!node || typeof node !== "object") return false;
  const pwr = Number(node.pwr);
  const conn = Number(node.conn);
  return (pwr === 1) || ((conn & 1) !== 0);
}

function getLiveConnectivityState(meshServer, nodeId) {
  const parent = meshServer && meshServer.parent;
  if (!parent || typeof parent.GetConnectivityState !== "function" || !nodeId) {
    return null;
  }

  try {
    return parent.GetConnectivityState(nodeId) || null;
  } catch (ex) {
    return null;
  }
}

function getMeshMaps(meshServer) {
  const maps = [];
  if (meshServer && meshServer.meshes && typeof meshServer.meshes === "object") {
    maps.push(meshServer.meshes);
  }
  const webserver = meshServer && meshServer.webserver;
  if (webserver && webserver.meshes && typeof webserver.meshes === "object") {
    maps.push(webserver.meshes);
  }
  return maps;
}

function findMeshById(meshServer, meshId) {
  if (!meshId) return null;
  const maps = getMeshMaps(meshServer);
  for (const map of maps) {
    const direct = map[meshId];
    if (direct && typeof direct === "object") return direct;
  }
  for (const map of maps) {
    for (const key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      const mesh = map[key];
      if (!mesh || typeof mesh !== "object") continue;
      if (String(mesh._id || "") === meshId) return mesh;
    }
  }
  return null;
}

function resolveTargetMesh(meshServer, domainId, rawTargetMeshId) {
  const target = String(rawTargetMeshId || "").trim();
  if (!target) return null;

  const candidateIds = [target];
  if (target.indexOf("/") === -1) {
    candidateIds.push(`mesh/${domainId}/${target}`);
  }

  for (const candidate of candidateIds) {
    const found = findMeshById(meshServer, candidate);
    if (found) return found;
  }

  return null;
}

function getNodeById(db, meshServer, nodeId) {
  return new Promise((resolve) => {
    if (!nodeId) { resolve(null); return; }

    const cachedNodes = (meshServer && meshServer.nodes && typeof meshServer.nodes === "object") ? meshServer.nodes : null;
    if (cachedNodes && cachedNodes[nodeId] && typeof cachedNodes[nodeId] === "object") {
      resolve(cachedNodes[nodeId]);
      return;
    }

    if (!db || typeof db.Get !== "function") {
      resolve(null);
      return;
    }

    try {
      db.Get(nodeId, function (err, docs) {
        if (err || !Array.isArray(docs) || docs.length === 0) { resolve(null); return; }
        resolve(docs[0]);
      });
    } catch (ex) {
      resolve(null);
    }
  });
}

function setDbRecord(db, record) {
  return new Promise((resolve) => {
    if (!db || typeof db.Set !== "function" || !record) { resolve(); return; }
    try {
      db.Set(record, function () { resolve(); });
    } catch (ex) {
      resolve();
    }
  });
}

function getDbRecord(db, id) {
  return new Promise((resolve) => {
    if (!db || typeof db.Get !== "function" || !id) { resolve(null); return; }
    try {
      db.Get(id, function (err, docs) {
        if (err || !Array.isArray(docs) || docs.length === 0) { resolve(null); return; }
        resolve(docs[0]);
      });
    } catch (ex) {
      resolve(null);
    }
  });
}

function getOs2GroupId(domainId) {
  return `ugrp/${String(domainId || "").trim()}/os2`;
}

function ensureEntityLinks(entity) {
  entity.links = (entity.links && typeof entity.links === "object") ? entity.links : {};
  return entity.links;
}

function syncCachedEntity(meshServer, cacheName, key, entity) {
  if (!meshServer || typeof meshServer !== "object" || !key || !entity) return;

  if (meshServer[cacheName] && typeof meshServer[cacheName] === "object") {
    meshServer[cacheName][key] = entity;
  }

  const webserver = meshServer.webserver;
  if (webserver && webserver[cacheName] && typeof webserver[cacheName] === "object") {
    webserver[cacheName][key] = entity;
  }
}

function getDomainIdFromGroupId(groupId) {
  const parts = String(groupId || "").split("/");
  return (parts.length >= 3) ? parts[1] : "";
}

function getLatestTypedRecordsById(docs) {
  const latest = new Map();
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (doc && typeof doc === "object" && typeof doc._id === "string" && doc._id.length > 0) {
      latest.set(doc._id, doc);
    }
  }
  return Array.from(latest.values());
}

function getAllTypeRecords(db, type) {
  return new Promise((resolve) => {
    if (!db || typeof db.GetAllType !== "function") { resolve([]); return; }
    try {
      db.GetAllType(type, function (err, docs) {
        if (err || !Array.isArray(docs)) { resolve([]); return; }
        resolve(getLatestTypedRecordsById(docs));
      });
    } catch (ex) {
      resolve([]);
    }
  });
}

async function mergeGroupMemberLinksFromUsers(db, meshServer, groupId, links) {
  const domainId = getDomainIdFromGroupId(groupId);
  const users = []
    .concat(Object.values((meshServer && meshServer.users && typeof meshServer.users === "object") ? meshServer.users : {}))
    .concat(await getAllTypeRecords(db, "user"));

  for (const user of users) {
    if (!user || typeof user !== "object" || typeof user._id !== "string" || user._id.length === 0) continue;
    if (domainId && !user._id.startsWith(`user/${domainId}/`)) continue;
    const userLinks = (user.links && typeof user.links === "object") ? user.links : {};
    const membership = userLinks[groupId];
    if (!membership || typeof membership !== "object") continue;

    const rights = Number.isFinite(membership.rights) ? membership.rights : 1;
    if (!links[user._id] || typeof links[user._id] !== "object") {
      links[user._id] = {
        userid: user._id,
        name: (typeof user.name === "string" && user.name.trim().length > 0) ? user.name.trim() : user._id,
        rights
      };
    }
  }
}

async function mergeGroupMeshLinksFromMeshes(db, meshServer, groupId, links) {
  const domainId = getDomainIdFromGroupId(groupId);
  const meshes = []
    .concat(Object.values((meshServer && meshServer.meshes && typeof meshServer.meshes === "object") ? meshServer.meshes : {}))
    .concat(await getAllTypeRecords(db, "mesh"));

  for (const mesh of meshes) {
    if (!mesh || typeof mesh !== "object" || typeof mesh._id !== "string" || mesh._id.length === 0) continue;
    if (domainId && !mesh._id.startsWith(`mesh/${domainId}/`)) continue;
    const meshLinks = (mesh.links && typeof mesh.links === "object") ? mesh.links : {};
    const groupLink = meshLinks[groupId];
    if (!groupLink || typeof groupLink !== "object") continue;

    const rights = Number.isFinite(groupLink.rights) ? groupLink.rights : MESH_RIGHTS_HELPDESK;
    links[mesh._id] = { rights };
  }
}

function buildMeshPrincipalLinks(principals) {
  const links = {};
  for (const principal of Array.isArray(principals) ? principals : []) {
    if (!principal || typeof principal.id !== "string" || principal.id.length === 0) continue;
    links[principal.id] = {
      rights: Number.isFinite(principal.rights) ? principal.rights : MESH_RIGHTS_HELPDESK,
      ...(typeof principal.name === "string" && principal.name.trim().length > 0 ? { name: principal.name.trim() } : {})
    };
  }
  return links;
}

function buildDefaultMeshPrincipals(user, domainId) {
  const principals = [];
  if (user && typeof user._id === "string" && user._id.length > 0) {
    principals.push({
      id: user._id,
      name: (typeof user.name === "string" && user.name.trim().length > 0) ? user.name.trim() : "MeshCentral Admin",
      rights: MESH_RIGHTS_ADMIN
    });
  }

  principals.push({
    id: getOs2GroupId(domainId),
    name: "OS2",
    rights: MESH_RIGHTS_HELPDESK
  });

  return principals;
}

async function ensurePrincipalMeshLink(db, meshServer, principal, meshId) {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0 || !meshId) return false;
  const rights = Number.isFinite(principal.rights) ? principal.rights : MESH_RIGHTS_HELPDESK;

  if (principal.type === "user") {
    const user = (principal.entity && typeof principal.entity === "object")
      ? principal.entity
      : ((meshServer && meshServer.users && typeof meshServer.users === "object") ? meshServer.users[principal.id] : null);
    if (!user || typeof user !== "object") return false;

    const links = ensureEntityLinks(user);
    links[meshId] = { rights };
    if (typeof db.SetUser === "function") {
      db.SetUser(user);
    } else {
      db.Set(user);
    }

    syncCachedEntity(meshServer, "users", user._id, user);

    if (meshServer && typeof meshServer.DispatchEvent === "function") {
      const account = (meshServer.webserver && typeof meshServer.webserver.CloneSafeUser === "function")
        ? meshServer.webserver.CloneSafeUser(user)
        : user;
      meshServer.DispatchEvent(['*', 'server-users', user._id], null, {
        etype: 'user',
        userid: user._id,
        username: user.name,
        account,
        action: 'accountchange',
        domain: user.domain,
        nolog: 1
      });
    }
    return true;
  }

  if (principal.type === "group") {
    if (!meshServer.userGroups || typeof meshServer.userGroups !== "object") {
      meshServer.userGroups = {};
    }

    const userGroup = meshServer.userGroups[principal.id];
    if (!userGroup || typeof userGroup !== "object") return false;

    const links = ensureEntityLinks(userGroup);
    links[meshId] = { rights };
    db.Set(userGroup);
    syncCachedEntity(meshServer, "userGroups", principal.id, userGroup);
    return true;
  }

  return false;
}

function dispatchMeshEvent(meshServer, mesh, action) {
  if (!meshServer) return;

  try {
    if (typeof meshServer.DispatchEvent !== "function") return;
    const webserver = meshServer.webserver;
    if (!webserver) return;
    if (typeof webserver.CreateMeshDispatchTargets !== "function") return;
    if (typeof webserver.CloneSafeMesh !== "function") return;

    const safeMesh = webserver.CloneSafeMesh(mesh);
    const creatorId = mesh && typeof mesh.creatorid === "string" ? mesh.creatorid : "";
    const targets = (action === "createmesh")
      ? ["*", "server-createmesh", mesh && mesh._id, creatorId].filter((entry) => typeof entry === "string" && entry.length > 0)
      : webserver.CreateMeshDispatchTargets(mesh, [creatorId, "server-editmesh"].filter((entry) => typeof entry === "string" && entry.length > 0));
    meshServer.DispatchEvent(
      targets,
      null,
      {
        action,
        mesh: safeMesh,
        meshid: mesh && mesh._id,
        name: mesh && mesh.name,
        mtype: mesh && mesh.mtype,
        desc: mesh && mesh.desc,
        flags: mesh && mesh.flags,
        consent: mesh && mesh.consent,
        links: mesh && mesh.links,
        domain: mesh && mesh.domain,
        msg: action === "createmesh" ? ("Device group created: " + (mesh && mesh.name ? mesh.name : "")) : ("Device group changed: " + (mesh && mesh.name ? mesh.name : ""))
      }
    );
  } catch (error) {
    // Keep persistence path working even if the live event dispatch fails.
  }
}

function isUserInOs2Group(meshServer, user, domainId) {
  if (!user || typeof user !== "object") return false;
  const groupId = `ugrp/${String(domainId || "").trim()}/os2`;
  const links = (user.links && typeof user.links === "object") ? user.links : {};

  if (links[groupId]) {
    return true;
  }

  const userGroups = (meshServer && meshServer.userGroups && typeof meshServer.userGroups === "object") ? meshServer.userGroups : {};
  const group = userGroups[groupId];
  if (!group || typeof group !== "object") return false;

  const memberLinks = (group.links && typeof group.links === "object") ? group.links : {};
  return Object.prototype.hasOwnProperty.call(memberLinks, user._id);
}

function createDevicePluginTabHooks() {
  return {
    exports: ["onWebUIStartupEnd", "onDeviceRefreshEnd"],

    onWebUIStartupEnd: function () {
      if (typeof pluginHandler !== "object" || pluginHandler == null) return;
      if (typeof pluginHandler.registerPluginTab !== "function") return;

      var tabInfo = { tabId: "ssbconfig-device", tabTitle: "SSB Config" };
      pluginHandler.registerPluginTab(tabInfo);

      if (typeof window !== "object" || window == null) return;
      if (typeof window.ssbconfigRenderDeviceTab !== "function") {
        window.ssbconfigRenderDeviceTab = function () {
          var page = document.getElementById(tabInfo.tabId);
          if (page == null) return;

          var esc = function (text) {
            return String(text == null ? "" : text)
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/\"/g, "&quot;")
              .replace(/'/g, "&#39;");
          };

          var node = (typeof currentNode === "object" && currentNode != null) ? currentNode : null;
          var isDeviceOn = false;
          if (node != null) {
            var pwr = Number(node.pwr);
            var conn = Number(node.conn);
            isDeviceOn = (pwr === 1) || ((conn & 1) !== 0);
          }

          var availableGroups = [];
          if (typeof meshes === "object" && meshes != null) {
            for (var meshId in meshes) {
              if (!Object.prototype.hasOwnProperty.call(meshes, meshId)) continue;
              var mesh = meshes[meshId];
              if (mesh == null || typeof mesh !== "object") continue;
              if (node != null && mesh._id === node.meshid) continue;
              availableGroups.push(mesh);
            }
          }

          availableGroups.sort(function (a, b) {
            var an = String((a && a.name) || "").toLowerCase();
            var bn = String((b && b.name) || "").toLowerCase();
            if (an < bn) return -1;
            if (an > bn) return 1;
            return 0;
          });

          var options = '<option value="">Select device group</option>';
          for (var i = 0; i < availableGroups.length; i++) {
            options += '<option value="' + esc(availableGroups[i]._id) + '">' + esc(availableGroups[i].name || availableGroups[i]._id) + '</option>';
          }

          page.innerHTML = '' +
            '<div style="padding:8px">' +
              '<div style="font-weight:600;margin-bottom:8px">Move Device To Group</div>' +
              '<div style="margin-bottom:8px">' +
                '<select id="ssbconfigMoveTarget" style="min-width:240px;max-width:100%">' + options + '</select>' +
                '<button id="ssbconfigMoveBtn" style="margin-left:8px">Move</button>' +
              '</div>' +
              '<div id="ssbconfigMoveStatus" style="color:#666"></div>' +
            '</div>';

          var statusEl = document.getElementById("ssbconfigMoveStatus");
          var selectEl = document.getElementById("ssbconfigMoveTarget");
          var moveBtn = document.getElementById("ssbconfigMoveBtn");
          if (!statusEl || !selectEl || !moveBtn) return;

          if (node == null || !node._id) {
            selectEl.disabled = true;
            moveBtn.disabled = true;
            statusEl.textContent = "No device is selected.";
            return;
          }

          if (!isDeviceOn) {
            selectEl.disabled = true;
            moveBtn.disabled = true;
            statusEl.textContent = "Move is only available when the device is turned on.";
            return;
          }

          if (availableGroups.length === 0) {
            selectEl.disabled = true;
            moveBtn.disabled = true;
            statusEl.textContent = "No available device groups you can move this device to.";
            return;
          }

          statusEl.textContent = "Choose a target group and click Move.";

          moveBtn.addEventListener("click", async function () {
            var latestNode = (typeof currentNode === "object" && currentNode != null) ? currentNode : null;
            if (latestNode == null || !latestNode._id) {
              statusEl.textContent = "No device is selected.";
              return;
            }

            var latestPwr = Number(latestNode.pwr);
            var latestConn = Number(latestNode.conn);
            var latestIsOn = (latestPwr === 1) || ((latestConn & 1) !== 0);
            if (!latestIsOn) {
              statusEl.textContent = "Move is only available when the device is turned on.";
              return;
            }

            var targetMeshId = String(selectEl.value || "");
            if (!targetMeshId) {
              statusEl.textContent = "Please select a target device group.";
              return;
            }

            if (targetMeshId === latestNode.meshid) {
              statusEl.textContent = "Device is already in that group.";
              return;
            }

            moveBtn.disabled = true;
            statusEl.textContent = "Sending move request...";
            try {
              var response = await fetch("./pluginadmin.ashx?pin=ssbconfig&api=move-device&user=1", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({
                  nodeid: latestNode._id,
                  targetMeshId: targetMeshId,
                  requireOnline: true
                })
              });

              var payload = {};
              try { payload = await response.json(); } catch (jsonEx) { payload = {}; }
              if (!response.ok || !payload || payload.ok !== true) {
                var errorText = String((payload && (payload.error || payload.result)) || "Move failed.");
                statusEl.textContent = errorText;
                return;
              }

              statusEl.textContent = String(payload.message || "Device moved.");
              if (typeof meshserver.send === "function") {
                meshserver.send({ action: "meshes" });
              }
              if (typeof refreshDevice === "function") {
                setTimeout(function () { refreshDevice(latestNode._id); }, 500);
              }
            } catch (ex) {
              statusEl.textContent = "Failed to send move request.";
            } finally {
              setTimeout(function () {
                if (moveBtn) moveBtn.disabled = false;
              }, 700);
            }
          });
        };
      }

      try { window.ssbconfigRenderDeviceTab(); } catch (ex) { }
    },

    onDeviceRefreshEnd: function () {
      if (typeof pluginHandler !== "object" || pluginHandler == null) return;
      if (typeof pluginHandler.registerPluginTab !== "function") return;

      var tabInfo = { tabId: "ssbconfig-device", tabTitle: "SSB Config" };
      pluginHandler.registerPluginTab(tabInfo);

      if (typeof window === "object" && window != null && typeof window.ssbconfigRenderDeviceTab === "function") {
        try { window.ssbconfigRenderDeviceTab(); } catch (ex) { }
      }
    }
  };
}

function createMeshcentralService(meshServer, debug) {
  async function moveDeviceByPolicy(domainId, user, input) {
    const db = meshServer && meshServer.db;
    if (!db) {
      return { ok: false, result: "Database is unavailable." };
    }

    const policy = getMovePolicy(meshServer, domainId);
    if (!policy.enabled) {
      return { ok: false, result: "Move operation is disabled by policy." };
    }

    const sourceInputNodeId = String(input && input.nodeid || "");
    const targetMeshId = String(input && input.targetMeshId || "").trim();
    if (!sourceInputNodeId || !targetMeshId) {
      return { ok: false, result: "Missing nodeid or targetMeshId." };
    }

    const nodeId = normalizeNodeId(sourceInputNodeId, domainId);
    const node = await getNodeById(db, meshServer, nodeId);
    if (!node || typeof node !== "object") {
      return { ok: false, result: "Device not found." };
    }

    const sourceMesh = findMeshById(meshServer, String(node.meshid || ""));
    const targetMesh = resolveTargetMesh(meshServer, domainId, targetMeshId);
    if (!targetMesh || typeof targetMesh !== "object") {
      return { ok: false, result: "Unknown target device group: " + targetMeshId };
    }

    const resolvedTargetMeshId = String(targetMesh._id || targetMeshId);

    const nodeDomain = String(node.domain || "");
    const targetDomain = String(targetMesh.domain || "");
    if (nodeDomain !== String(domainId || "") || targetDomain !== String(domainId || "")) {
      return { ok: false, result: "Invalid domain." };
    }

    if (node.meshid === resolvedTargetMeshId) {
      return { ok: false, result: "Device already in that group." };
    }

    if (!sourceMesh || typeof sourceMesh !== "object") {
      return { ok: false, result: "Source device group not found." };
    }

    if (Number(sourceMesh.mtype) !== Number(targetMesh.mtype)) {
      return { ok: false, result: "Device groups are of different types." };
    }

    if (Number(sourceMesh.mtype) !== DEVICE_GROUP_TYPE || Number(targetMesh.mtype) !== DEVICE_GROUP_TYPE) {
      return { ok: false, result: "Only standard device-group moves are allowed." };
    }

    if (!meshMatchesPolicy(sourceMesh, policy.allowedSourceMeshIds, policy.allowedSourceMeshNames, policy.allowedSourceNameRegex)) {
      return { ok: false, result: "Source device group is blocked by policy." };
    }
    if (!meshMatchesPolicy(targetMesh, policy.allowedTargetMeshIds, policy.allowedTargetMeshNames, policy.allowedTargetNameRegex)) {
      return { ok: false, result: "Target device group is blocked by policy." };
    }

    const oldMeshId = node.meshid;
    const updatedNode = { ...node, meshid: resolvedTargetMeshId };
    const cleanNode = (meshServer && typeof meshServer.cleanDevice === "function") ? meshServer.cleanDevice(updatedNode) : updatedNode;
    await setDbRecord(db, cleanNode);
    syncCachedEntity(meshServer, "nodes", nodeId, updatedNode);

    const wsagents = meshServer && meshServer.wsagents;
    const agentSession = wsagents && wsagents[nodeId];
    if (agentSession) {
      agentSession.dbMeshKey = resolvedTargetMeshId;
      const parts = String(resolvedTargetMeshId).split("/");
      if (parts.length >= 3) {
        agentSession.meshid = parts[2];
      }
      if (typeof agentSession.sendUpdatedIntelAmtPolicy === "function") {
        agentSession.sendUpdatedIntelAmtPolicy();
      }
    }

    const mqttBroker = (meshServer && meshServer.parent && meshServer.parent.mqttbroker) || (meshServer && meshServer.mqttbroker);
    if (mqttBroker && typeof mqttBroker.changeDeviceMesh === "function") {
      mqttBroker.changeDeviceMesh(nodeId, resolvedTargetMeshId);
    }

    const mpsServer = (meshServer && meshServer.parent && meshServer.parent.mpsserver) || (meshServer && meshServer.mpsserver);
    if (mpsServer && typeof mpsServer.changeDeviceMesh === "function") {
      mpsServer.changeDeviceMesh(nodeId, resolvedTargetMeshId);
    }

    const lastConnectRecord = await getDbRecord(db, "lc" + nodeId);
    if (lastConnectRecord && typeof lastConnectRecord === "object" && lastConnectRecord.meshid !== resolvedTargetMeshId) {
      lastConnectRecord.meshid = resolvedTargetMeshId;
      await setDbRecord(db, lastConnectRecord);
    }

    if (meshServer && typeof meshServer.DispatchEvent === "function" && meshServer.webserver && typeof meshServer.webserver.CreateMeshDispatchTargets === "function") {
      const movedNode = { ...updatedNode };
      const event = {
        etype: "node",
        userid: (user && user._id) ? user._id : "",
        username: (user && user.name) ? user.name : "MeshCentral Admin",
        action: "nodemeshchange",
        nodeid: nodeId,
        node: movedNode,
        oldMeshId,
        newMeshId: resolvedTargetMeshId,
        domain: domainId,
        msg: "Moved device " + (movedNode.name || nodeId) + " to group " + (targetMesh.name || resolvedTargetMeshId)
      };
      const targets = meshServer.webserver.CreateMeshDispatchTargets(resolvedTargetMeshId, [oldMeshId, nodeId]);
      meshServer.DispatchEvent(targets, null, event);
    }

    debug(
      "plugin:ssbconfig",
      "device move by policy",
      {
        by: (user && user._id) ? user._id : "",
        nodeid: nodeId,
        oldMeshId,
        newMeshId: resolvedTargetMeshId,
        domain: domainId
      }
    );

    return {
      ok: true,
      result: "ok",
      message: "Device moved successfully.",
      nodeid: nodeId,
      oldMeshId,
      newMeshId: resolvedTargetMeshId
    };
  }

  async function ensureOs2UserGroup(domainId) {
    const db = meshServer && meshServer.db;
    if (!db || typeof db.Set !== "function") return null;

    if (!meshServer.userGroups || typeof meshServer.userGroups !== "object") { meshServer.userGroups = {}; }
    if (meshServer.webserver && (!meshServer.webserver.userGroups || typeof meshServer.webserver.userGroups !== "object")) { meshServer.webserver.userGroups = meshServer.userGroups; }

    const groupId = getOs2GroupId(domainId);
    const groups = meshServer.userGroups;
    let group = groups[groupId] || null;
    if (group && typeof group === "object") return group;

    const existingByName = Object.values(groups).find((entry) => {
      return entry && typeof entry === "object" && entry.domain === domainId && String(entry.name || "") === "OS2";
    });
    if (existingByName) {
      groups[groupId] = existingByName;
      return existingByName;
    }

    group = {
      _id: groupId,
      type: "ugrp",
      domain: domainId,
      name: "OS2",
      creation: Date.now(),
      links: {}
    };

    const groupLinks = ensureEntityLinks(group);
    await mergeGroupMemberLinksFromUsers(db, meshServer, groupId, groupLinks);
    await mergeGroupMeshLinksFromMeshes(db, meshServer, groupId, groupLinks);

    db.Set(group);
    syncCachedEntity(meshServer, "userGroups", groupId, group);
    debug("plugin:ssbconfig", `OS2 init: created user group in domain \"${domainId || "default"}\".`);
    return group;
  }

  async function syncCreatedImageconfigGroups(domainId, createdImageconfigs, user) {
    const outcome = {
      created: 0,
      updated: 0,
      warnings: [],
      imageconfigMeshLinks: []
    };

    const items = Array.isArray(createdImageconfigs) ? createdImageconfigs : [];
    debug("plugin:ssbconfig", `group sync start: domain=${domainId || "default"}, items=${items.length}`);
    if (items.length === 0) return outcome;

    const db = meshServer && meshServer.db;
    if (!db || typeof db.Set !== "function") {
      outcome.warnings.push("MeshCentral DB API unavailable; skipped device-group sync.");
      debug("plugin:ssbconfig", "group sync skipped: MeshCentral DB API unavailable");
      return outcome;
    }

    const os2Group = await ensureOs2UserGroup(domainId);
    const principals = buildDefaultMeshPrincipals(user, domainId);
    const meshPrincipalLinks = buildMeshPrincipalLinks(principals);
    const creatorId = (user && typeof user._id === "string") ? user._id : "";
    const creatorName = (user && typeof user.name === "string" && user.name.trim().length > 0) ? user.name.trim() : "MeshCentral Admin";
    if (!os2Group) {
      outcome.warnings.push(`OS2 user group unavailable in domain ${domainId || "default"}; group links may be incomplete.`);
    }
    debug("plugin:ssbconfig", `group sync creator: id=${creatorId || "(empty)"}, name=${creatorName}`);

    for (const item of items) {
      const requestedMeshName = String(item && item.groupName ? item.groupName : "").trim();
      if (!requestedMeshName) {
        outcome.warnings.push(`Skipped group creation for ${item && item.path ? item.path : "imageconfig"}: missing name.`);
        debug("plugin:ssbconfig", `group sync skip: missing groupName for ${item && item.path ? item.path : "imageconfig"}`);
        continue;
      }

      try {
        const imageId = String(item && item.imageId ? item.imageId : "").trim();
        let existing = null;
        if (imageId) {
          const resolvedByImageId = resolveTargetMesh(meshServer, domainId, imageId);
          if (resolvedByImageId && typeof resolvedByImageId === "object" && String(resolvedByImageId.domain || "") === String(domainId || "")) {
            existing = resolvedByImageId;
          }
        }

        // Reuse only when image_id resolves to an existing mesh in this domain.
        if (existing) {
          const existingLinks = ensureEntityLinks(existing);
          Object.assign(existingLinks, meshPrincipalLinks);
          db.Set(existing);
          for (const principal of principals) {
            await ensurePrincipalMeshLink(db, meshServer, {
              ...principal,
              type: principal.id.startsWith("ugrp/") ? "group" : "user",
              entity: principal.id === creatorId ? user : null
            }, existing._id);
          }
          dispatchMeshEvent(meshServer, existing, "meshchange");
          outcome.imageconfigMeshLinks.push({
            path: String(item && item.path ? item.path : ""),
            groupName: requestedMeshName,
            meshId: String(existing._id || ""),
            reused: true
          });
          outcome.updated += 1;
          debug("plugin:ssbconfig", `group sync updated: domain=${domainId || "default"}, requestedName=${requestedMeshName}, id=${existing._id || "unknown"}`);
          continue;
        }

        // Otherwise create a new mesh group using the requested display/name.
        const meshId = `mesh/${domainId}/${crypto.randomBytes(9).toString("base64").replace(/\+/g, "@").replace(/\//g, "$")}`;
        const mesh = {
          _id: meshId,
          type: "mesh",
          mtype: 2,
          name: requestedMeshName,
          domain: domainId,
          links: { ...meshPrincipalLinks },
          creation: Date.now(),
          creatorid: creatorId,
          creatorname: creatorName
        };

        db.Set(mesh);
        for (const principal of principals) {
          await ensurePrincipalMeshLink(db, meshServer, {
            ...principal,
            type: principal.id.startsWith("ugrp/") ? "group" : "user",
            entity: principal.id === creatorId ? user : null
          }, meshId);
        }
        syncCachedEntity(meshServer, "meshes", meshId, mesh);

        dispatchMeshEvent(meshServer, mesh, "createmesh");

        outcome.imageconfigMeshLinks.push({
          path: String(item && item.path ? item.path : ""),
          groupName: requestedMeshName,
          meshId,
          reused: false
        });

        outcome.created += 1;
        debug("plugin:ssbconfig", `group sync created: domain=${domainId || "default"}, requestedName=${requestedMeshName}, id=${meshId}`);
      } catch (error) {
        outcome.warnings.push(`Failed to sync device group for ${item && item.path ? item.path : "imageconfig"}: ${error.message || error}`);
        debug("plugin:ssbconfig", "group sync failed", error);
      }
    }

    debug("plugin:ssbconfig", `group sync done: created=${outcome.created}, updated=${outcome.updated}, warnings=${outcome.warnings.length}`);
    return outcome;
  }

  return {
    syncCreatedImageconfigGroups,
    isUserInOs2Group,
    createDevicePluginTabHooks,
    moveDeviceByPolicy
  };
}

module.exports = {
  createMeshcentralService
};
