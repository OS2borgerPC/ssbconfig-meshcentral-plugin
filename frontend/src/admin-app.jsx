import React, { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Form from '@rjsf/mui';
import validator from '@rjsf/validator-ajv8';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography
} from '@mui/material';

function toBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function buildPluginUrl(queryString) {
  return `./pluginadmin.ashx${queryString}`;
}

function resolveJsonPointer(root, ref) {
  if (!root || typeof root !== 'object' || typeof ref !== 'string' || !ref.startsWith('#/')) {
    return null;
  }

  const tokens = ref
    .slice(2)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current = root;
  for (const token of tokens) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, token)) {
      return null;
    }
    current = current[token];
  }

  return current;
}

function mergeUiSchemas(base, extra) {
  if (!base || typeof base !== 'object') return extra || {};
  if (!extra || typeof extra !== 'object') return base;

  const out = { ...base };
  for (const key of Object.keys(extra)) {
    const baseVal = out[key];
    const extraVal = extra[key];

    if (Array.isArray(baseVal) && Array.isArray(extraVal)) {
      const len = Math.max(baseVal.length, extraVal.length);
      out[key] = Array.from({ length: len }, (_, idx) => {
        const b = baseVal[idx];
        const e = extraVal[idx];
        if (b && typeof b === 'object' && !Array.isArray(b) && e && typeof e === 'object' && !Array.isArray(e)) {
          return mergeUiSchemas(b, e);
        }
        return e !== undefined ? e : b;
      });
      continue;
    }

    if (baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal) && extraVal && typeof extraVal === 'object' && !Array.isArray(extraVal)) {
      out[key] = mergeUiSchemas(baseVal, extraVal);
      continue;
    }

    out[key] = extraVal;
  }

  return out;
}

function getEffectiveSchema(rootSchema, schemaNode, seenRefs = new Set()) {
  if (!schemaNode || typeof schemaNode !== 'object') {
    return {};
  }

  let resolved = { ...schemaNode };

  if (typeof resolved.$ref === 'string' && !seenRefs.has(resolved.$ref)) {
    seenRefs.add(resolved.$ref);
    const refSchema = resolveJsonPointer(rootSchema, resolved.$ref);
    const expandedRef = getEffectiveSchema(rootSchema, refSchema, seenRefs);
    const withoutRef = { ...resolved };
    delete withoutRef.$ref;
    resolved = { ...expandedRef, ...withoutRef };

    if (expandedRef['x-ssb-file'] || withoutRef['x-ssb-file']) {
      resolved['x-ssb-file'] = {
        ...(expandedRef['x-ssb-file'] || {}),
        ...(withoutRef['x-ssb-file'] || {})
      };
    }
  }

  if (Array.isArray(resolved.allOf)) {
    let merged = { ...resolved };
    delete merged.allOf;

    for (const part of resolved.allOf) {
      const expandedPart = getEffectiveSchema(rootSchema, part, new Set(seenRefs));
      merged = { ...expandedPart, ...merged };
      if (expandedPart['x-ssb-file'] || merged['x-ssb-file']) {
        merged['x-ssb-file'] = {
          ...(expandedPart['x-ssb-file'] || {}),
          ...(merged['x-ssb-file'] || {})
        };
      }
    }

    resolved = merged;
  }

  return resolved;
}

function buildFileWidgetFallbackUiSchema(rootSchema, schemaNode) {
  const effective = getEffectiveSchema(rootSchema, schemaNode);
  const ui = {};

  const fileCfg = effective && typeof effective['x-ssb-file'] === 'object' ? effective['x-ssb-file'] : null;
  if (fileCfg && fileCfg.enabled === true) {
    ui['ui:widget'] = 'file';
    const options = {};
    if (typeof fileCfg.accept === 'string' && fileCfg.accept) {
      options.accept = fileCfg.accept;
    }
    if (typeof fileCfg.assetPrefixTemplate === 'string' && fileCfg.assetPrefixTemplate) {
      options.assetPrefixTemplate = fileCfg.assetPrefixTemplate;
    }
    if (Object.keys(options).length > 0) {
      ui['ui:options'] = options;
    }
  }

  if (effective.properties && typeof effective.properties === 'object') {
    for (const [key, childSchema] of Object.entries(effective.properties)) {
      const childUi = buildFileWidgetFallbackUiSchema(rootSchema, childSchema);
      if (Object.keys(childUi).length > 0) {
        ui[key] = childUi;
      }
    }
  }

  if (effective.items && typeof effective.items === 'object') {
    const itemUi = buildFileWidgetFallbackUiSchema(rootSchema, effective.items);
    if (Object.keys(itemUi).length > 0) {
      ui.items = itemUi;
    }
  }

  if (Array.isArray(effective.oneOf)) {
    const oneOfUi = effective.oneOf.map((entry) => buildFileWidgetFallbackUiSchema(rootSchema, entry));
    if (oneOfUi.some((entry) => Object.keys(entry).length > 0)) {
      ui.oneOf = oneOfUi;
    }
  }

  return ui;
}

function getRepoContext() {
  if (typeof window === 'undefined' || !window.__SSBCONFIG_REPO_CONTEXT__ || typeof window.__SSBCONFIG_REPO_CONTEXT__ !== 'object') {
    return null;
  }
  return window.__SSBCONFIG_REPO_CONTEXT__;
}

function buildDownloadUrl(pathValue) {
  const repo = getRepoContext();
  if (!repo || !pathValue) {
    return null;
  }

  const owner = encodeURIComponent(String(repo.owner || '').trim());
  const repository = encodeURIComponent(String(repo.repo || '').trim());
  const branch = encodeURIComponent(String(repo.branch || '').trim());
  const encodedPath = String(pathValue || '').split('/').map((s) => encodeURIComponent(s)).join('/');
  if (!owner || !repository || !branch || !encodedPath) {
    return null;
  }

  return `https://raw.githubusercontent.com/${owner}/${repository}/${branch}/${encodedPath}`;
}

function resolveAssetPrefix(assetPrefixTemplate, domainId) {
  const rawDomain = String(domainId || '').trim();
  const safeDomain = /^[a-z][a-z0-9-_]*$/.test(rawDomain) ? rawDomain : 'default';
  const template = String(assetPrefixTemplate || 'config/assets/{domain}/');
  return template.replace('{domain}', safeDomain);
}

function ensureUploadedFilesStore() {
  if (!window.__SSBCONFIG_UPLOADED_FILES__ || typeof window.__SSBCONFIG_UPLOADED_FILES__ !== 'object') {
    window.__SSBCONFIG_UPLOADED_FILES__ = {};
  }
  return window.__SSBCONFIG_UPLOADED_FILES__;
}

function sanitizeUploadedFileName(fileName) {
  return String(fileName || 'upload.bin')
    .replace(/[\\/]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_');
}

async function parseApiResponse(response) {
  const raw = await response.text();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    return {
      error: raw.length > 600 ? `${raw.slice(0, 600)}...` : raw
    };
  }
}

// Custom file upload widget for RJSF
function FileWidget(props) {
  const {
    value,
    onChange,
    options = {},
    label,
    id,
    required,
    schema = {}
  } = props;

  const fileInputRef = useRef(null);
  const assetPrefixTemplate = options.assetPrefixTemplate || 'config/assets/{domain}/';
  const accept = options.accept || '*/*';

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const base64Content = toBase64(arrayBuffer);
      const uploadedFiles = ensureUploadedFilesStore();
      const fileName = sanitizeUploadedFileName(file.name);
      const activeDomainId =
        typeof window !== 'undefined' && typeof window.__SSBCONFIG_DOMAIN_ID__ === 'string'
          ? window.__SSBCONFIG_DOMAIN_ID__
          : '';
      const assetPrefix = resolveAssetPrefix(assetPrefixTemplate, activeDomainId);
      const pathValue = `${assetPrefix}${fileName}`;
      uploadedFiles[pathValue] = base64Content;
      onChange(pathValue);
      
      // Reset the input so selecting the same file again triggers change
      event.target.value = '';
    } catch (err) {
      console.error('Error reading file:', err);
    }
  };

  const fileName = value ? value.split('/').pop() : null;
  const hasFile = value && value.startsWith('config/assets/');
  const downloadUrl = hasFile ? buildDownloadUrl(value) : null;

  return (
    <Box sx={{ mb: 2 }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>
        {label}
        {required && <span style={{ color: 'red' }}> *</span>}
      </label>
      <input
        ref={fileInputRef}
        id={id}
        type="file"
        accept={accept}
        onChange={handleFileChange}
        style={{ marginBottom: '8px', display: 'block' }}
      />
      {hasFile && (
        <Stack spacing={0.5} sx={{ mt: 1 }}>
          <Typography variant="caption" sx={{ color: 'green', display: 'block' }}>
            {downloadUrl ? (
              <a
                href={downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                download={fileName || undefined}
                style={{ color: 'inherit' }}
              >
                Current file: {fileName}
              </a>
            ) : (
              <>Current file: {fileName}</>
            )}
          </Typography>
        </Stack>
      )}
      {value && !hasFile && (
        <Typography variant="caption" sx={{ color: 'gray', display: 'block', mt: 1 }}>
          Value: {value}
        </Typography>
      )}
    </Box>
  );
}

function MeshGroupIdWidget(props) {
  const {
    value,
    onChange,
    options = {},
    label,
    id,
    required,
    readonly,
    disabled
  } = props;

  const meshGroups = Array.isArray(options.meshGroups) ? options.meshGroups : [];
  const currentValue = typeof value === 'string' ? value : '';
  const hasCurrentValue = currentValue.length > 0;
  const containsCurrent = meshGroups.some((entry) => entry && entry.meshid === currentValue);

  return (
    <TextField
      id={id}
      select
      fullWidth
      size="small"
      label={label || 'Device Group ID'}
      required={required}
      value={currentValue}
      disabled={Boolean(readonly || disabled)}
      onChange={(event) => onChange(event.target.value)}
      helperText="Select a MeshCentral device group by name; the selected meshid will be stored in this field."
      sx={{ mb: 2 }}
    >
      <MenuItem value="">Select MeshCentral device group</MenuItem>
      {meshGroups.map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const meshid = typeof entry.meshid === 'string' ? entry.meshid : '';
        const name = typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name : meshid;
        if (!meshid) return null;
        return (
          <MenuItem key={meshid} value={meshid}>
            {name}
          </MenuItem>
        );
      })}
      {hasCurrentValue && !containsCurrent ? (
        <MenuItem value={currentValue}>
          Current value (not found): {currentValue}
        </MenuItem>
      ) : null}
    </TextField>
  );
}

function PolicyMultiSelectField(props) {
  const {
    formData,
    onChange,
    schema = {},
    uiSchema = {},
    label,
    required,
    readonly,
    disabled,
    rawErrors = []
  } = props;

  const policyOptions = Array.isArray(uiSchema['ui:options']?.policies)
    ? uiSchema['ui:options'].policies
    : [];
  const selectedIds = Array.isArray(formData) ? formData.filter((value) => typeof value === 'string' && value.length > 0) : [];
  const optionById = new Map(
    policyOptions
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const id = typeof entry.id === 'string' ? entry.id : '';
        if (!id) return null;
        const name = typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : id;
        return [id, name];
      })
      .filter(Boolean)
  );

  const selectedLabel = selectedIds.length > 0
    ? selectedIds.map((id) => optionById.get(id) || id).join(', ')
    : 'Select policies';

  return (
    <TextField
      select
      fullWidth
      size="small"
      label={label || schema.title || 'Policies'}
      required={required}
      value={selectedIds}
      disabled={Boolean(readonly || disabled)}
      onChange={(event) => {
        const nextValue = event.target.value;
        const nextIds = Array.isArray(nextValue)
          ? nextValue
          : String(nextValue || '').split(',').filter((value) => value.length > 0);
        onChange(nextIds);
      }}
      SelectProps={{
        multiple: true,
        displayEmpty: true,
        renderValue: (selected) => {
          const ids = Array.isArray(selected) ? selected : [];
          if (ids.length === 0) {
            return 'Select policies';
          }
          return ids.map((id) => optionById.get(id) || id).join(', ');
        }
      }}
      helperText={rawErrors.length > 0 ? rawErrors[0] : 'Choose one or more policies by name; the selected ids are stored in this device group.'}
      sx={{ mb: 2 }}
    >
      {policyOptions.length === 0 ? (
        <MenuItem value="" disabled>
          No policies available yet
        </MenuItem>
      ) : null}
      {policyOptions.map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const id = typeof entry.id === 'string' ? entry.id : '';
        if (!id) return null;
        const name = typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : id;
        return (
          <MenuItem key={id} value={id}>
            {name}
          </MenuItem>
        );
      })}
      {selectedIds
        .filter((id) => !optionById.has(id))
        .map((id) => (
          <MenuItem key={`missing-${id}`} value={id}>
            Current value (not found): {id}
          </MenuItem>
        ))}
    </TextField>
  );
}

function MasterDetailTab({
  items,
  onItemsChange,
  getLabel,
  getSecondary,
  detailSchema,
  detailUiSchema,
  detailFormDataUnwrap,
  idPrefix,
  selectorTitle,
  detailTitle,
  addLabel,
  deleteLabel,
  minItems,
  customWidgets,
  customFields,
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  React.useEffect(() => {
    const len = Array.isArray(items) ? items.length : 0;
    if (len === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0);
      return;
    }
    if (selectedIndex >= len) {
      setSelectedIndex(len - 1);
    }
  }, [items, selectedIndex]);

  const safeItems = Array.isArray(items) ? items : [];
  const selectedItem =
    safeItems[selectedIndex] && typeof safeItems[selectedIndex] === 'object'
      ? safeItems[selectedIndex]
      : {};

  const limit = minItems ?? 1;

  return (
    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 2, alignItems: 'stretch' }}>
      <Box sx={{ width: { xs: '100%', md: 300 }, flexShrink: 0, border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
        <Stack spacing={1}>
          <Typography variant="subtitle2">{selectorTitle}</Typography>
          <List dense disablePadding>
            {safeItems.map((item, index) => (
              <ListItemButton
                key={index}
                selected={index === selectedIndex}
                onClick={() => setSelectedIndex(index)}
                sx={{ borderRadius: 1, mb: 0.5 }}
              >
                <ListItemText
                  primary={getLabel(item, index)}
                  secondary={getSecondary ? getSecondary(item, index) : undefined}
                />
              </ListItemButton>
            ))}
          </List>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                const next = [...safeItems, {}];
                onItemsChange(next);
                setSelectedIndex(next.length - 1);
              }}
            >
              {addLabel}
            </Button>
            <Button
              size="small"
              color="error"
              variant="outlined"
              disabled={safeItems.length <= limit}
              onClick={() => {
                const next = safeItems.filter((_, idx) => idx !== selectedIndex);
                onItemsChange(limit === 0 && next.length === 0 ? [] : (next.length > 0 ? next : [{}]));
                setSelectedIndex((prev) => Math.max(0, prev - 1));
              }}
            >
              {deleteLabel}
            </Button>
          </Stack>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>{detailTitle}</Typography>
        {detailSchema && safeItems.length > 0 ? (
          <Form
            idPrefix={idPrefix}
            schema={detailSchema}
            {...(detailUiSchema ? { uiSchema: detailUiSchema } : {})}
            {...(customFields ? { fields: customFields } : {})}
            formData={selectedItem}
            validator={validator}
            widgets={customWidgets}
            noValidate
            liveValidate={false}
            noHtml5Validate
            showErrorList={false}
            onChange={({ formData: nextFormData }) => {
              const nextItem = detailFormDataUnwrap
                ? detailFormDataUnwrap(nextFormData, selectedItem)
                : (nextFormData && typeof nextFormData === 'object' ? nextFormData : {});
              const nextItems = [...safeItems];
              nextItems[selectedIndex] = nextItem;
              onItemsChange(nextItems);
            }}
          >
            <div />
          </Form>
        ) : (
          <Typography variant="body2" color="text.secondary">No items selected.</Typography>
        )}
      </Box>
    </Box>
  );
}

function App() {
  const injectedDomainId = typeof window !== 'undefined' && typeof window.__SSBCONFIG_DOMAIN_ID__ === 'string'
    ? window.__SSBCONFIG_DOMAIN_ID__
    : '';
  const [status, setStatus] = useState({ type: 'info', message: 'Loading config from GitHub...' });
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [repoInfo, setRepoInfo] = useState('');
  const [previewContent, setPreviewContent] = useState('');
  const [previewErrors, setPreviewErrors] = useState([]);

  const [schema, setSchema] = useState(null);
  const [uiSchema, setUiSchema] = useState(null);
  const [data, setData] = useState({});
  const [configFileSha, setConfigFileSha] = useState('');
  const [meshDeviceGroups, setMeshDeviceGroups] = useState([]);

  const [domainId, setDomainId] = useState(injectedDomainId);
  const [activeTab, setActiveTab] = useState('policies');
  const [commitMessage, setCommitMessage] = useState('Update config and assets from MeshCentral plugin');

  const assetPathInfo = useMemo(() => {
    if (!domainId) return 'Assets path in repo: assets/(default)/...';
    return `Assets path in repo: assets/${domainId}/...`;
  }, [domainId]);

  // Extract uploaded files from window and prepare for commit
  const getUploadedFiles = () => {
    if (!window.__SSBCONFIG_UPLOADED_FILES__ || typeof window.__SSBCONFIG_UPLOADED_FILES__ !== 'object') {
      return [];
    }

    return Object.entries(window.__SSBCONFIG_UPLOADED_FILES__).map(([path, content]) => ({ path, content }));
  };

  const customWidgets = useMemo(() => ({
    file: FileWidget,
    FileWidget,
    meshGroupIdSelect: MeshGroupIdWidget
  }), []);

  const customFields = useMemo(() => ({
    policyMultiSelect: PolicyMultiSelectField
  }), []);

  const availableTabs = useMemo(() => {
    if (!schema || !schema.properties || typeof schema.properties !== 'object') {
      return [];
    }

    const tabs = [];
    if (Object.prototype.hasOwnProperty.call(schema.properties, 'policies')) {
      tabs.push({ key: 'policies', label: 'Policies' });
    }
    if (Object.prototype.hasOwnProperty.call(schema.properties, 'device_groups')) {
      tabs.push({ key: 'device_groups', label: 'Device Groups' });
    }
    return tabs;
  }, [schema]);

  React.useEffect(() => {
    if (!availableTabs.length) return;
    if (!availableTabs.find((tab) => tab.key === activeTab)) {
      setActiveTab(availableTabs[0].key);
    }
  }, [availableTabs, activeTab]);

  const activeTabSchema = useMemo(() => {
    if (!schema || !activeTab || !schema.properties || !schema.properties[activeTab]) {
      return null;
    }

    const nextSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        [activeTab]: schema.properties[activeTab]
      }
    };
    if (Array.isArray(schema.required) && schema.required.includes(activeTab)) {
      nextSchema.required = [activeTab];
    }
    if (schema.$defs && typeof schema.$defs === 'object') {
      nextSchema.$defs = schema.$defs;
    }
    if (schema.definitions && typeof schema.definitions === 'object') {
      nextSchema.definitions = schema.definitions;
    }
    return nextSchema;
  }, [schema, activeTab]);

  const policyDetailSchema = useMemo(() => {
    if (!schema || !schema.properties || !schema.properties.policies) return null;

    const policiesSchema = getEffectiveSchema(schema, schema.properties.policies);
    const rawItemSchema = policiesSchema && typeof policiesSchema.items === 'object'
      ? getEffectiveSchema(schema, policiesSchema.items)
      : { type: 'object', properties: {} };

    // Strip 'id' — preserved via detailFormDataUnwrap in MasterDetailTab.
    const { id: _omitId, ...itemProperties } = rawItemSchema.properties || {};
    const itemRequired = Array.isArray(rawItemSchema.required)
      ? rawItemSchema.required.filter((f) => f !== 'id')
      : [];

    return {
      ...rawItemSchema,
      properties: itemProperties,
      ...(itemRequired.length > 0 ? { required: itemRequired } : {}),
      ...(schema.$defs ? { $defs: schema.$defs } : {}),
      ...(schema.definitions ? { definitions: schema.definitions } : {})
    };
  }, [schema]);

  const activeTabUiSchema = useMemo(() => {
    if (!uiSchema || typeof uiSchema !== 'object' || !activeTab) {
      return undefined;
    }
    if (!uiSchema[activeTab] || typeof uiSchema[activeTab] !== 'object') {
      return undefined;
    }
    return { [activeTab]: uiSchema[activeTab] };
  }, [uiSchema, activeTab]);

  const effectiveActiveTabUiSchema = useMemo(() => {
    if (!schema || !activeTab || !schema.properties || !schema.properties[activeTab]) {
      return activeTabUiSchema;
    }

    const fallbackSection = buildFileWidgetFallbackUiSchema(schema, schema.properties[activeTab]);
    const fallbackWrapped = Object.keys(fallbackSection).length > 0 ? { [activeTab]: fallbackSection } : {};
    const merged = mergeUiSchemas(fallbackWrapped, activeTabUiSchema || {});
    return Object.keys(merged).length > 0 ? merged : undefined;
  }, [schema, activeTab, activeTabUiSchema]);

  const policyDetailUiSchema = useMemo(() => {
    if (!schema || !schema.properties || !schema.properties.policies) return undefined;

    const policiesSchema = getEffectiveSchema(schema, schema.properties.policies);
    const itemSchema = policiesSchema && typeof policiesSchema.items === 'object'
      ? policiesSchema.items : {};
    const fallbackUi = buildFileWidgetFallbackUiSchema(schema, itemSchema);
    const configuredUi =
      uiSchema?.policies?.items && typeof uiSchema.policies.items === 'object'
        ? uiSchema.policies.items : {};
    const merged = mergeUiSchemas(fallbackUi, configuredUi);
    return Object.keys(merged).length > 0 ? merged : undefined;
  }, [schema, uiSchema]);

  const deviceGroupDetailSchema = useMemo(() => {
    if (!schema || !schema.properties || !schema.properties.device_groups) return null;

    const dgSchema = getEffectiveSchema(schema, schema.properties.device_groups);
    const rawItemSchema = dgSchema && typeof dgSchema.items === 'object'
      ? getEffectiveSchema(schema, dgSchema.items)
      : { type: 'object', properties: {} };

    return {
      ...rawItemSchema,
      ...(schema.$defs ? { $defs: schema.$defs } : {}),
      ...(schema.definitions ? { definitions: schema.definitions } : {})
    };
  }, [schema]);

  const deviceGroupDetailUiSchema = useMemo(() => {
    if (!schema || !schema.properties || !schema.properties.device_groups) return undefined;

    const dgSchema = getEffectiveSchema(schema, schema.properties.device_groups);
    const itemSchema = dgSchema && typeof dgSchema.items === 'object' ? dgSchema.items : {};
    const fallbackUi = buildFileWidgetFallbackUiSchema(schema, itemSchema);
    const configuredUi =
      uiSchema?.device_groups?.items && typeof uiSchema.device_groups.items === 'object'
        ? uiSchema.device_groups.items : {};
    const merged = mergeUiSchemas(fallbackUi, configuredUi);

    merged.policies = {
      ...(merged.policies && typeof merged.policies === 'object' ? merged.policies : {}),
      'ui:field': 'policyMultiSelect',
      'ui:options': {
        ...(
          merged.policies &&
          typeof merged.policies === 'object' &&
          merged.policies['ui:options'] &&
          typeof merged.policies['ui:options'] === 'object'
            ? merged.policies['ui:options']
            : {}
        ),
        policies: data && Array.isArray(data.policies) ? data.policies : []
      }
    };

    merged.id = {
      ...(merged.id && typeof merged.id === 'object' ? merged.id : {}),
      'ui:widget': 'meshGroupIdSelect',
      'ui:options': {
        ...(
          merged.id &&
          typeof merged.id === 'object' &&
          merged.id['ui:options'] &&
          typeof merged.id['ui:options'] === 'object'
            ? merged.id['ui:options']
            : {}
        ),
        meshGroups: meshDeviceGroups
      }
    };

    return Object.keys(merged).length > 0 ? merged : undefined;
  }, [schema, uiSchema, meshDeviceGroups, data]);

  const activeTabData = useMemo(() => {
    const defaults = activeTab === 'policies' ? [{}] : [];
    const sectionData = data && typeof data === 'object' ? data[activeTab] : undefined;
    return {
      [activeTab]: sectionData === undefined ? defaults : sectionData
    };
  }, [data, activeTab]);

  function makeItemsChangeHandler(key) {
    return (nextItems) => {
      setData((prev) => ({ ...(prev || {}), [key]: nextItems }));
      setPreviewContent('');
      setPreviewErrors([]);
    };
  }

  async function fetchBootstrap() {
    setLoading(true);
    setStatus({ type: 'info', message: 'Loading config from GitHub...' });
    try {
      const response = await fetch(buildPluginUrl('?pin=ssbconfig&api=bootstrap&user=1'));
      const payload = await parseApiResponse(response);
      if (!response.ok) throw new Error(payload.error || 'Bootstrap failed');

      const nextData = payload.configData || {};

      setSchema(payload.schema || { type: 'object', properties: {} });
      setUiSchema(payload.uiSchema || null);
      setData(nextData);
      setMeshDeviceGroups(Array.isArray(payload.meshDeviceGroups) ? payload.meshDeviceGroups : []);
      setDomainId(typeof payload.domainId === 'string' ? payload.domainId : injectedDomainId);
      setPreviewContent('');
      setPreviewErrors([]);
      setConfigFileSha(typeof payload.configFileSha === 'string' ? payload.configFileSha : '');
      window.__SSBCONFIG_UPLOADED_FILES__ = {}; // Reset uploaded files on reload

      if (payload.configRepo) {
        setRepoInfo(`${payload.configRepo.owner}/${payload.configRepo.repo} @ ${payload.configRepo.branch} :: ${payload.configRepo.filePath}`);
        window.__SSBCONFIG_REPO_CONTEXT__ = {
          owner: payload.configRepo.owner,
          repo: payload.configRepo.repo,
          branch: payload.configRepo.branch
        };
      } else {
        setRepoInfo('');
        window.__SSBCONFIG_REPO_CONTEXT__ = null;
      }

      const activeDomain = typeof payload.domainId === 'string' && payload.domainId.length > 0 ? payload.domainId : injectedDomainId;
      if (activeDomain.length > 0) {
        setStatus({ type: 'success', message: `Loaded config for domain ${activeDomain}.` });
      } else {
        setStatus({ type: 'success', message: 'Loaded config for default domain.' });
      }
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Bootstrap failed' });
    } finally {
      setLoading(false);
    }
  }

  async function persistChanges(nextData) {
    if (!schema || !nextData || typeof nextData !== 'object') {
      setStatus({ type: 'error', message: 'No config data to save.' });
      return;
    }

    setSaving(true);
    setStatus({ type: 'info', message: 'Committing changes to GitHub...' });

    try {
      const uploadedFiles = getUploadedFiles();
      const dataToSave = {
        policies: Array.isArray(nextData?.policies) ? nextData.policies : [],
        device_groups: Array.isArray(nextData?.device_groups) ? nextData.device_groups : []
      };
      
      const response = await fetch(buildPluginUrl('?pin=ssbconfig&api=save&user=1'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configData: dataToSave,
          files: uploadedFiles,
          commitMessage,
          configFileSha
        })
      });

      const payload = await parseApiResponse(response);
      if (response.status === 409 && payload.conflict) {
        await fetchBootstrap();
        setStatus({ type: 'warning', message: payload.error || 'Conflict: reloaded latest config from GitHub.' });
        return;
      }
      if (!response.ok) throw new Error(payload.error || 'Save failed');

      setData(dataToSave);
      setStatus({
        type: 'success',
        message: `Committed ${payload.changedFiles ? payload.changedFiles.length : 0} file(s) for domain ${payload.domainId || domainId || injectedDomainId} on ${payload.branch}. Commit: ${payload.commitSha}`,
        rawConfigContent: payload.rawConfigContent || ''
      });
      window.__SSBCONFIG_UPLOADED_FILES__ = {}; // Clear after successful commit
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Save failed' });
    } finally {
      setSaving(false);
    }
  }

  async function previewChanges(nextData) {
    if (!schema || !nextData || typeof nextData !== 'object') {
      setStatus({ type: 'error', message: 'No config data to preview.' });
      return;
    }

    setPreviewing(true);
    setStatus({ type: 'info', message: 'Generating backend preview and validating full config.yml...' });

    try {
      const uploadedFiles = getUploadedFiles();
      const dataToPreview = {
        policies: Array.isArray(nextData?.policies) ? nextData.policies : [],
        device_groups: Array.isArray(nextData?.device_groups) ? nextData.device_groups : []
      };
      
      const response = await fetch(buildPluginUrl('?pin=ssbconfig&api=preview&user=1'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configData: dataToPreview,
          files: uploadedFiles,
          commitMessage,
          configFileSha
        })
      });

      const payload = await parseApiResponse(response);
      if (response.status === 409 && payload.conflict) {
        await fetchBootstrap();
        setStatus({ type: 'warning', message: payload.error || 'Conflict: reloaded latest config from GitHub.' });
        return;
      }
      if (!response.ok) throw new Error(payload.error || 'Preview failed');

      const errors = Array.isArray(payload.validationErrors) ? payload.validationErrors : [];
      setData(dataToPreview);
      setPreviewContent(payload.rawConfigContent || '');
      setPreviewErrors(errors);

      if (errors.length > 0) {
        setStatus({
          type: 'error',
          message: `Preview generated, but backend validation found ${errors.length} error${errors.length === 1 ? '' : 's'}.`,
          rawConfigContent: payload.rawConfigContent || ''
        });
      } else {
        setStatus({
          type: 'success',
          message: `Preview looks valid for domain ${payload.domainId || domainId || injectedDomainId}. You can now commit to GitHub.`,
          rawConfigContent: payload.rawConfigContent || ''
        });
      }
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Preview failed' });
    } finally {
      setPreviewing(false);
    }
  }

  async function onSave() {
    await previewChanges(data);
  }

  React.useEffect(() => {
    fetchBootstrap();
  }, []);

  return (
    <Box sx={{ p: 2, backgroundColor: '#f4f6fa', minHeight: '100vh' }}>
      <Stack spacing={2}>
        <Card>
          <CardContent>
            <Typography variant="h5">Sikker Selvbetjening Config Editor</Typography>
            <Typography variant="body2" color="text.secondary">
              JSON Forms bundle running locally inside this plugin.
            </Typography>
            {repoInfo ? (
              <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block', mt: 1 }}>
                {repoInfo}
              </Typography>
            ) : null}
            <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block', mt: 0.5 }}>
              Active MeshCentral domain: {domainId || '(default)'}
            </Typography>
            {configFileSha ? (
              <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block', mt: 0.5 }}>
                Loaded commit SHA: {configFileSha}
              </Typography>
            ) : null}
          </CardContent>
        </Card>

        <Alert severity={status.type === 'error' ? 'error' : status.type === 'success' ? 'success' : status.type === 'warning' ? 'warning' : 'info'}>
          <Stack spacing={1}>
            <Typography variant="body2">{status.message}</Typography>
          </Stack>
        </Alert>

        {previewErrors.length > 0 ? (
          <Alert severity="error">
            <Stack spacing={0.5}>
              <Typography variant="body2">Validation errors</Typography>
              {previewErrors.map((err, idx) => (
                <Typography key={`${idx}-${err.path || 'root'}`} variant="caption" sx={{ fontFamily: 'monospace' }}>
                  {(err && err.text) || (err && err.message) || 'Unknown validation error'}
                </Typography>
              ))}
            </Stack>
          </Alert>
        ) : null}

        {previewContent ? (
          <Card
            sx={{
              width: 'calc(100vw - 24px)',
              maxWidth: 'none',
              ml: 'calc(50% - 50vw + 12px)',
              mr: 'calc(50% - 50vw + 12px)'
            }}
          >
            <CardContent>
              <TextField
                label="Raw config.yml preview"
                multiline
                fullWidth
                minRows={10}
                maxRows={28}
                value={previewContent}
                InputProps={{
                  readOnly: true,
                  sx: {
                    fontFamily: 'monospace',
                    fontSize: 12,
                    '& textarea': {
                      whiteSpace: 'pre',
                      overflowX: 'auto',
                      overflowY: 'auto',
                      wordBreak: 'normal'
                    }
                  }
                }}
                inputProps={{ wrap: 'off' }}
              />
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>Config Form</Typography>
            {schema && availableTabs.length > 0 ? (
              <Stack spacing={2}>
                <Tabs
                  value={activeTab}
                  onChange={(_evt, value) => setActiveTab(value)}
                  variant="scrollable"
                  allowScrollButtonsMobile
                >
                  {availableTabs.map((tab) => (
                    <Tab key={tab.key} value={tab.key} label={tab.label} />
                  ))}
                </Tabs>

                {activeTab === 'policies' && policyDetailSchema ? (
                  <MasterDetailTab
                    items={Array.isArray(data?.policies) ? data.policies : [{}]}
                    onItemsChange={makeItemsChangeHandler('policies')}
                    getLabel={(item, index) => {
                      if (item && typeof item === 'object') {
                        if (typeof item.name === 'string' && item.name.trim().length > 0) return item.name;
                        if (typeof item.id === 'string' && item.id.trim().length > 0) return item.id;
                      }
                      return `Policy ${index + 1}`;
                    }}
                    getSecondary={(item) =>
                      item && typeof item.id === 'string' && item.id.trim().length > 0
                        ? `id: ${item.id}` : undefined
                    }
                    detailSchema={policyDetailSchema}
                    detailUiSchema={policyDetailUiSchema}
                    detailFormDataUnwrap={(formData, originalItem) => {
                      const next = formData && typeof formData === 'object' ? formData : {};
                      return typeof originalItem?.id === 'string'
                        ? { id: originalItem.id, ...next }
                        : next;
                    }}
                    idPrefix="ssbconfig-policy-detail"
                    selectorTitle="Policy selector"
                    detailTitle="Policy details"
                    addLabel="Add policy"
                    deleteLabel="Delete selected"
                    minItems={1}
                    customWidgets={customWidgets}
                  />
                ) : activeTab === 'device_groups' && deviceGroupDetailSchema ? (
                  <MasterDetailTab
                    items={Array.isArray(data?.device_groups) ? data.device_groups : []}
                    onItemsChange={makeItemsChangeHandler('device_groups')}
                    getLabel={(item, index) =>
                      item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim().length > 0
                        ? item.name
                        : `Device Group ${index + 1}`
                    }
                    detailSchema={deviceGroupDetailSchema}
                    detailUiSchema={deviceGroupDetailUiSchema}
                    detailFormDataUnwrap={(formData, originalItem) => {
                      const next = formData && typeof formData === 'object' ? formData : {};
                      return typeof originalItem?.id === 'string'
                        ? { id: originalItem.id, ...next }
                        : next;
                    }}
                    idPrefix="ssbconfig-device-group-detail"
                    selectorTitle="Device group selector"
                    detailTitle="Device group details"
                    addLabel="Add device group"
                    deleteLabel="Delete selected"
                    minItems={0}
                    customWidgets={customWidgets}
                    customFields={customFields}
                  />
                ) : (
                  activeTabSchema && (
                    <Form
                      idPrefix={`ssbconfig-${activeTab}`}
                      schema={activeTabSchema}
                      {...(effectiveActiveTabUiSchema ? { uiSchema: effectiveActiveTabUiSchema } : {})}
                      formData={activeTabData}
                      validator={validator}
                      widgets={customWidgets}
                      noValidate
                      liveValidate={false}
                      noHtml5Validate
                      showErrorList={false}
                      onChange={({ formData: nextSectionData }) => {
                        const merged = { ...(data || {}), ...(nextSectionData || {}) };
                        setData(merged);
                        setPreviewContent('');
                        setPreviewErrors([]);
                      }}
                    >
                      <div />
                    </Form>
                  )
                )}
              </Stack>
            ) : (
              <Typography variant="body2">Schema not loaded yet.</Typography>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>Assets + Commit</Typography>
            <Stack spacing={2}>
              <Typography variant="caption" sx={{ display: 'block', fontFamily: 'monospace' }}>
                {assetPathInfo}
              </Typography>

              <TextField
                fullWidth
                label="Commit message"
                value={commitMessage}
                onChange={(evt) => setCommitMessage(evt.target.value)}
              />

              <Stack direction="row" spacing={1}>
                <Button variant="contained" disabled={loading || previewing || saving} onClick={onSave}>
                  {previewing ? 'Previewing...' : 'Preview + Validate'}
                </Button>
                <Button
                  variant="contained"
                  color="success"
                  disabled={loading || previewing || saving || !previewContent || previewErrors.length > 0}
                  onClick={() => {
                    void persistChanges(data);
                  }}
                >
                  {saving ? 'Saving...' : 'Commit to GitHub'}
                </Button>
                <Button variant="outlined" disabled={loading || previewing || saving} onClick={fetchBootstrap}>
                  Reload
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      </Stack>
    </Box>
  );
}

const rootNode = document.getElementById('ssbconfig-root');
if (rootNode) {
  const root = createRoot(rootNode);
  root.render(<App />);
}
