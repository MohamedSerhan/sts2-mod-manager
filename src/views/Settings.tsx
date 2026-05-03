import { useState } from 'react';
import { FolderSearch, Key, ExternalLink } from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { detectGamePath, setGamePath, setNexusApiKey } from '../hooks/useTauri';

export function SettingsView() {
  const [gamePath, setGamePathValue] = useState('');
  const [nexusKey, setNexusKey] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  async function handleDetectGame() {
    try {
      const info = await detectGamePath();
      if (info.path) {
        setGamePathValue(info.path);
        setStatus('Game detected successfully!');
      } else {
        setStatus('Could not auto-detect game path.');
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSetGamePath() {
    if (!gamePath.trim()) return;
    try {
      await setGamePath(gamePath.trim());
      setStatus('Game path updated.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSaveNexusKey() {
    if (!nexusKey.trim()) return;
    try {
      await setNexusApiKey(nexusKey.trim());
      setStatus('Nexus API key saved.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text">Settings</h2>
        <p className="text-sm text-text-muted mt-1">
          Configure your mod manager
        </p>
      </div>

      {status && (
        <div className="bg-primary/10 border border-primary/30 rounded-lg px-4 py-2 text-sm text-primary">
          {status}
        </div>
      )}

      {/* Game Path */}
      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-text flex items-center gap-2">
          <FolderSearch size={16} />
          Game Path
        </h3>
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              placeholder="C:\Program Files\Steam\steamapps\common\STS2"
              value={gamePath}
              onChange={(e) => setGamePathValue(e.target.value)}
            />
          </div>
          <Button variant="secondary" size="md" onClick={handleDetectGame}>
            Auto-Detect
          </Button>
          <Button size="md" onClick={handleSetGamePath}>
            Save
          </Button>
        </div>
      </Card>

      {/* Nexus API Key */}
      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-text flex items-center gap-2">
          <Key size={16} />
          Nexus Mods API Key
        </h3>
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              type="password"
              placeholder="Enter your Nexus API key"
              value={nexusKey}
              onChange={(e) => setNexusKey(e.target.value)}
            />
          </div>
          <Button size="md" onClick={handleSaveNexusKey}>
            Save
          </Button>
        </div>
        <a
          href="https://www.nexusmods.com/users/myaccount?tab=api"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
        >
          <ExternalLink size={12} />
          Get your API key from Nexus Mods
        </a>
      </Card>

      {/* GitHub Token */}
      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-text flex items-center gap-2">
          <Key size={16} />
          GitHub Token
          <span className="text-xs text-text-dim font-normal">(optional)</span>
        </h3>
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              type="password"
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
            />
          </div>
          <Button variant="secondary" size="md">
            Save
          </Button>
        </div>
        <p className="text-xs text-text-dim">
          A GitHub token increases the API rate limit for mod searches.
        </p>
      </Card>

      {/* Protocol Handlers */}
      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-text">Protocol Handlers</h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm text-text">sts2mm:// handler</p>
              <p className="text-xs text-text-dim">
                Handle one-click install links
              </p>
            </div>
            <Button variant="secondary" size="sm">
              Register
            </Button>
          </div>
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm text-text">nxm:// handler</p>
              <p className="text-xs text-text-dim">
                Handle Nexus Mods download links
              </p>
            </div>
            <Button variant="secondary" size="sm">
              Register
            </Button>
          </div>
        </div>
      </Card>

      {/* About */}
      <Card className="space-y-2">
        <h3 className="text-sm font-semibold text-text">About</h3>
        <div className="text-xs text-text-dim space-y-1">
          <p>STS2 Mod Manager v0.1.0</p>
          <p>Built with Tauri + React</p>
          <p>Manage your Slay the Spire 2 mods with ease.</p>
        </div>
      </Card>
    </div>
  );
}
