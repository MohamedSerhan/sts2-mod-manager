import { useState, useEffect } from 'react';
import { FolderSearch, Key, FolderOpen } from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import {
  detectGamePath,
  setGamePath,
  setNexusApiKey,
  setGithubToken,
  openGameFolder,
  openModsFolder,
} from '../hooks/useTauri';

export function SettingsView() {
  const { gameInfo, refreshAll } = useApp();
  const toast = useToast();
  const [gamePath, setGamePathValue] = useState('');
  const [nexusKey, setNexusKey] = useState('');
  const [githubToken, setGithubTokenValue] = useState('');

  // Load current game path on mount
  useEffect(() => {
    if (gameInfo?.game_path) {
      setGamePathValue(gameInfo.game_path);
    }
  }, [gameInfo?.game_path]);

  async function handleDetectGame() {
    try {
      const info = await detectGamePath();
      if (info.valid && info.game_path) {
        setGamePathValue(info.game_path);
        await refreshAll();
        toast.success('Game detected successfully!');
      } else {
        toast.error('Could not auto-detect game path. Please set it manually.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSetGamePath() {
    if (!gamePath.trim()) return;
    try {
      const info = await setGamePath(gamePath.trim());
      if (info.valid) {
        await refreshAll();
        toast.success('Game path updated.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSaveNexusKey() {
    if (!nexusKey.trim()) return;
    try {
      await setNexusApiKey(nexusKey.trim());
      toast.success('Nexus API key saved.');
      setNexusKey('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSaveGithubToken() {
    if (!githubToken.trim()) return;
    try {
      await setGithubToken(githubToken.trim());
      toast.success('GitHub token saved.');
      setGithubTokenValue('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleOpenGameFolder() {
    try {
      await openGameFolder();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleOpenModsFolder() {
    try {
      await openModsFolder();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
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

      {/* Game Path */}
      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-text flex items-center gap-2">
          <FolderSearch size={16} />
          Game Path
        </h3>
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              placeholder="C:\Program Files\Steam\steamapps\common\Slay the Spire 2"
              value={gamePath}
              onChange={(e) => setGamePathValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSetGamePath()}
            />
          </div>
          <Button variant="secondary" size="md" onClick={handleDetectGame}>
            Auto-Detect
          </Button>
          <Button size="md" onClick={handleSetGamePath}>
            Save
          </Button>
        </div>
        {gameInfo?.valid && (
          <div className="flex gap-2 text-xs">
            <span className="text-green-400">
              {gameInfo.mods_count} mods detected
            </span>
            <span className="text-text-dim">|</span>
            <button onClick={handleOpenGameFolder} className="text-primary hover:underline">
              Open Game Folder
            </button>
            <span className="text-text-dim">|</span>
            <button onClick={handleOpenModsFolder} className="text-primary hover:underline">
              Open Mods Folder
            </button>
          </div>
        )}
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
              onKeyDown={(e) => e.key === 'Enter' && handleSaveNexusKey()}
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
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline transition-colors"
        >
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
              onChange={(e) => setGithubTokenValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveGithubToken()}
            />
          </div>
          <Button variant="secondary" size="md" onClick={handleSaveGithubToken}>
            Save
          </Button>
        </div>
        <p className="text-xs text-text-dim">
          Use a <strong>Classic</strong> Personal Access Token with the <strong>gist</strong> scope for profile sharing.
          Fine-grained tokens do NOT support Gists. Also increases API rate limit to 5,000 req/hr.
        </p>
      </Card>

      {/* Quick Actions */}
      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-text flex items-center gap-2">
          <FolderOpen size={16} />
          Quick Actions
        </h3>
        <div className="flex gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={handleOpenGameFolder}>
            Open Game Folder
          </Button>
          <Button variant="secondary" size="sm" onClick={handleOpenModsFolder}>
            Open Mods Folder
          </Button>
        </div>
      </Card>

      {/* Protocol Handlers */}
      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-text">Protocol Handlers</h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm text-text">sts2mm:// handler</p>
              <p className="text-xs text-text-dim">
                Handle one-click install links (registered automatically)
              </p>
            </div>
            <span className="text-xs text-green-400">Active</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm text-text">nxm:// handler</p>
              <p className="text-xs text-text-dim">
                Handle Nexus Mods download links (registered automatically)
              </p>
            </div>
            <span className="text-xs text-green-400">Active</span>
          </div>
        </div>
      </Card>

      {/* About */}
      <Card className="space-y-2">
        <h3 className="text-sm font-semibold text-text">About</h3>
        <div className="text-xs text-text-dim space-y-1">
          <p>STS2 Mod Manager v0.1.0</p>
          <p>Built with Tauri 2 + React + Rust</p>
          <p>Manage your Slay the Spire 2 mods with ease.</p>
        </div>
      </Card>
    </div>
  );
}
