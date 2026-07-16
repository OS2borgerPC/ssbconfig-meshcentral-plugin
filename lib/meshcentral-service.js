"use strict";

const crypto = require("crypto");

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
  function ensureOs2UserGroupOnStartup() {
    const db = meshServer && meshServer.db;
    if (!db || typeof db.Set !== "function") {
      debug("plugin:ssbconfig", "OS2 init: MeshCentral DB API unavailable; cannot create user group.");
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
      const groupId = `ugrp/${domainId}/os2`;
      const existsById = !!groups[groupId];
      const existsByName = Object.values(groups).some((group) => {
        return group && typeof group === "object" && group.domain === domainId && String(group.name || "") === "OS2";
      });
      if (existsById || existsByName) continue;

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
      debug("plugin:ssbconfig", `OS2 init: created user group in domain \"${domainId || "default"}\".`);
    }
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
    const adminLinks = buildAdminMeshLinks(user);
    const creatorId = (user && typeof user._id === "string") ? user._id : "";
    const creatorName = (user && typeof user.name === "string" && user.name.trim().length > 0) ? user.name.trim() : "MeshCentral Admin";
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
