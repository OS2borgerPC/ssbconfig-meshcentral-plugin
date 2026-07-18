"use strict";

const crypto = require("crypto");

const MESH_RIGHTS_ADMIN = 0xFFFFFFFF;
// Helpdesk profile: remote control, terminal, files, wake, notes, remote view.
const MESH_RIGHTS_HELPDESK = 0x000001F8;

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
  const encodedGroupId = encodeURIComponent(groupId);
  const users = []
    .concat(Object.values((meshServer && meshServer.users && typeof meshServer.users === "object") ? meshServer.users : {}))
    .concat(await getAllTypeRecords(db, "user"));

  for (const user of users) {
    if (!user || typeof user !== "object" || typeof user._id !== "string" || user._id.length === 0) continue;
    if (domainId && !user._id.startsWith(`user/${domainId}/`)) continue;
    const userLinks = (user.links && typeof user.links === "object") ? user.links : {};
    const membership = userLinks[groupId] || userLinks[encodedGroupId];
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
  const encodedGroupId = encodeURIComponent(groupId);
  const meshes = []
    .concat(Object.values((meshServer && meshServer.meshes && typeof meshServer.meshes === "object") ? meshServer.meshes : {}))
    .concat(await getAllTypeRecords(db, "mesh"));

  for (const mesh of meshes) {
    if (!mesh || typeof mesh !== "object" || typeof mesh._id !== "string" || mesh._id.length === 0) continue;
    if (domainId && !mesh._id.startsWith(`mesh/${domainId}/`)) continue;
    const meshLinks = (mesh.links && typeof mesh.links === "object") ? mesh.links : {};
    const groupLink = meshLinks[groupId] || meshLinks[encodedGroupId];
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
    if (typeof db.GetAllType === "function") {
      const allUsers = await getAllTypeRecords(db, "user");
      const latestUser = allUsers.find((entry) => entry && entry._id === user._id);
      if (latestUser && latestUser.links && typeof latestUser.links === "object") {
        Object.assign(links, latestUser.links);
      }
      const allGroups = await getAllTypeRecords(db, "ugrp");
      for (const group of allGroups) {
        if (!group || !group.links || typeof group.links !== "object") continue;
        const membership = group.links[user._id];
        if (!membership || typeof membership !== "object") continue;
        links[group._id] = links[group._id] || { rights: Number.isFinite(membership.rights) ? membership.rights : 1 };
      }
      const allMeshes = await getAllTypeRecords(db, "mesh");
      for (const mesh of allMeshes) {
        if (!mesh || !mesh.links || typeof mesh.links !== "object") continue;
        const access = mesh.links[user._id];
        if (!access || typeof access !== "object") continue;
        links[mesh._id] = links[mesh._id] || { rights: Number.isFinite(access.rights) ? access.rights : rights };
      }
    }
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
    await mergeGroupMeshLinksFromMeshes(db, meshServer, principal.id, links);
    await mergeGroupMemberLinksFromUsers(db, meshServer, principal.id, links);
    links[meshId] = { rights };
    db.Set(userGroup);
    syncCachedEntity(meshServer, "userGroups", principal.id, userGroup);
    return true;
  }

  return false;
}

function dispatchMeshEvent(meshServer, mesh, action) {
  const webserver = meshServer && meshServer.webserver;
  if (!meshServer || typeof meshServer.DispatchEvent !== "function" || !webserver || typeof webserver.CreateMeshDispatchTargets !== "function" || typeof webserver.CloneSafeMesh !== "function") return;

  try {
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
  const encodedGroupId = encodeURIComponent(groupId);

  if (links[groupId] || links[encodedGroupId]) {
    return true;
  }

  const userGroups = (meshServer && meshServer.userGroups && typeof meshServer.userGroups === "object") ? meshServer.userGroups : {};
  const group = userGroups[groupId] || userGroups[encodedGroupId];
  if (!group || typeof group !== "object") return false;

  const memberLinks = (group.links && typeof group.links === "object") ? group.links : {};
  return Object.prototype.hasOwnProperty.call(memberLinks, user._id);
}

function createMeshcentralService(meshServer, debug) {
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

  function ensureOs2UserGroupOnStartup() {
    debug("plugin:ssbconfig", "OS2 init: startup mutation disabled to avoid overwriting existing group links.");
  }

  async function syncCreatedImageconfigGroups(domainId, createdImageconfigs, user) {
    const outcome = {
      created: 0,
      updated: 0,
      warnings: []
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

    const meshes = (meshServer && meshServer.meshes && typeof meshServer.meshes === "object") ? meshServer.meshes : {};
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
      const groupName = String(item && item.groupName ? item.groupName : "").trim();
      if (!groupName) {
        outcome.warnings.push(`Skipped group creation for ${item && item.path ? item.path : "imageconfig"}: missing name.`);
        debug("plugin:ssbconfig", `group sync skip: missing groupName for ${item && item.path ? item.path : "imageconfig"}`);
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
          const existingLinks = ensureEntityLinks(existing);
          Object.assign(existingLinks, meshPrincipalLinks);
          if (imageId) {
            existing.tags = (existing.tags && typeof existing.tags === "object") ? existing.tags : {};
            existing.tags.image_id = imageId;
            existing.image_id = imageId;
          }
          db.Set(existing);
          for (const principal of principals) {
            await ensurePrincipalMeshLink(db, meshServer, {
              ...principal,
              type: principal.id.startsWith("ugrp/") ? "group" : "user",
              entity: principal.id === creatorId ? user : null
            }, existing._id);
          }
          dispatchMeshEvent(meshServer, existing, "meshchange");
          outcome.updated += 1;
          debug("plugin:ssbconfig", `group sync updated: domain=${domainId || "default"}, group=${groupName}, id=${existing._id || "unknown"}`);
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
          links: { ...meshPrincipalLinks },
          creation: Date.now(),
          creatorid: creatorId,
          creatorname: creatorName
        };

        if (imageId) {
          mesh.tags = { image_id: imageId };
          mesh.image_id = imageId;
        }

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

        outcome.created += 1;
        debug("plugin:ssbconfig", `group sync created: domain=${domainId || "default"}, group=${groupName}, id=${meshId}`);
      } catch (error) {
        outcome.warnings.push(`Failed to sync device group for ${item && item.path ? item.path : "imageconfig"}: ${error.message || error}`);
        debug("plugin:ssbconfig", "group sync failed", error);
      }
    }

    debug("plugin:ssbconfig", `group sync done: created=${outcome.created}, updated=${outcome.updated}, warnings=${outcome.warnings.length}`);
    return outcome;
  }

  return {
    ensureOs2UserGroupOnStartup,
    syncCreatedImageconfigGroups,
    isUserInOs2Group
  };
}

module.exports = {
  createMeshcentralService
};
