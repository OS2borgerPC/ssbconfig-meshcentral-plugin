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
    FileWidget
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

  const activeTabData = useMemo(() => {
    const defaults = activeTab === 'policies' ? [{}] : [];
    const sectionData = data && typeof data === 'object' ? data[activeTab] : undefined;
    return {
      [activeTab]: sectionData === undefined ? defaults : sectionData
    };
  }, [data, activeTab]);

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
            {schema && availableTabs.length > 0 && activeTabSchema ? (
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
