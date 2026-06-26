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
  TextField,
  Typography
} from '@mui/material';

function normalizePath(input) {
  return String(input || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

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

function App() {
  const submitButtonRef = useRef(null);
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
  const [data, setData] = useState({});

  const [domainId, setDomainId] = useState(injectedDomainId);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [commitMessage, setCommitMessage] = useState('Update config and assets from MeshCentral plugin');

  const assetPathInfo = useMemo(() => {
    if (!domainId) return 'Assets path in repo: assets/(default)/...';
    return `Assets path in repo: assets/${domainId}/...`;
  }, [domainId]);

  async function fetchBootstrap() {
    setLoading(true);
    setStatus({ type: 'info', message: 'Loading config from GitHub...' });
    try {
      const response = await fetch(buildPluginUrl('?pin=ssbconfig&api=bootstrap&user=1'));
      const payload = await parseApiResponse(response);
      if (!response.ok) throw new Error(payload.error || 'Bootstrap failed');

      const nextData = payload.configData || {};

      setSchema(payload.schema || { type: 'object', properties: {} });
      setData(nextData);
      setDomainId(typeof payload.domainId === 'string' ? payload.domainId : injectedDomainId);
      setSelectedFiles([]);
      setPreviewContent('');
      setPreviewErrors([]);

      if (payload.configRepo) {
        setRepoInfo(`${payload.configRepo.owner}/${payload.configRepo.repo} @ ${payload.configRepo.branch} :: ${payload.configRepo.filePath}`);
      } else {
        setRepoInfo('');
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
      const response = await fetch(buildPluginUrl('?pin=ssbconfig&api=save&user=1'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configData: nextData,
          assets: selectedFiles,
          commitMessage
        })
      });

      const payload = await parseApiResponse(response);
      if (!response.ok) throw new Error(payload.error || 'Save failed');

      setData(nextData);
      setStatus({
        type: 'success',
        message: `Committed ${payload.changedFiles ? payload.changedFiles.length : 0} file(s) for domain ${payload.domainId || domainId || injectedDomainId} on ${payload.branch}. Commit: ${payload.commitSha}`,
        rawConfigContent: payload.rawConfigContent || ''
      });
      setSelectedFiles([]);
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
      const response = await fetch(buildPluginUrl('?pin=ssbconfig&api=preview&user=1'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configData: nextData,
          assets: selectedFiles,
          commitMessage
        })
      });

      const payload = await parseApiResponse(response);
      if (!response.ok) throw new Error(payload.error || 'Preview failed');

      const errors = Array.isArray(payload.validationErrors) ? payload.validationErrors : [];
      setData(nextData);
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

  async function onFileSelection(evt) {
    const files = Array.from(evt.target.files || []);
    const converted = [];

    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const relative = normalizePath(file.webkitRelativePath || file.name);
      converted.push({
        path: relative,
        contentBase64: toBase64(buffer)
      });
    }

    setSelectedFiles(converted);
  }

  async function onSave() {
    if (submitButtonRef.current) {
      submitButtonRef.current.click();
      return;
    }

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
          </CardContent>
        </Card>

        <Alert severity={status.type === 'error' ? 'error' : status.type === 'success' ? 'success' : 'info'}>
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
            {schema ? (
              <Form
                idPrefix="ssbconfig"
                schema={schema}
                formData={data}
                validator={validator}
                noValidate
                liveValidate={false}
                noHtml5Validate
                showErrorList={false}
                onChange={({ formData: nextData }) => {
                  setData(nextData || {});
                  setPreviewContent('');
                  setPreviewErrors([]);
                }}
                onSubmit={({ formData: nextData }) => {
                  void previewChanges(nextData || {});
                }}
              >
                <button
                  ref={submitButtonRef}
                  type="submit"
                  style={{ display: 'none' }}
                  aria-hidden="true"
                  tabIndex={-1}
                >
                  Submit
                </button>
              </Form>
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

              <Box>
                <Typography variant="body2" sx={{ mb: 0.5 }}>Upload files or folder</Typography>
                <input type="file" multiple webkitdirectory="" onChange={onFileSelection} />
                <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>
                  Selected files: {selectedFiles.length}
                </Typography>
              </Box>

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
