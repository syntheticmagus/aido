import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/appStore.ts';

interface FileExplorerProps {
  projectName: string;
}

export function FileExplorer({ projectName }: FileExplorerProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchFiles = async () => {
    try {
      const res = await fetch(`/artifacts/${projectName}`);
      if (res.ok) {
        const data = await res.json() as { entries: string[] };
        setFiles(data.entries ?? []);
      }
    } catch {
      // Ignore — workspace may not exist yet
    }
  };

  useEffect(() => {
    fetchFiles();
  }, [projectName]);

  // Refresh on workspace changes (Phase 5 will emit workspace:changed)
  useEffect(() => {
    const interval = setInterval(fetchFiles, 10_000); // poll every 10s as fallback
    return () => clearInterval(interval);
  }, [projectName]);

  const openFile = async (name: string) => {
    setSelectedFile(name);
    setLoading(true);
    setFileContent(null);
    try {
      const res = await fetch(`/artifacts/${projectName}/${name}`);
      if (res.ok) {
        const text = await res.text();
        setFileContent(text);
      }
    } catch {
      setFileContent('(error loading file)');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full gap-4">
      <div className="w-48 overflow-y-auto">
        <div className="text-xs text-gray-500 mb-2">Workspace files</div>
        {files.length === 0 ? (
          <div className="text-xs text-gray-600">No files yet</div>
        ) : (
          files.map((f) => (
            <div
              key={f}
              className={`text-xs py-0.5 px-2 rounded cursor-pointer truncate ${selectedFile === f ? 'bg-blue-800 text-white' : 'text-gray-400 hover:bg-gray-800'}`}
              onClick={() => openFile(f)}
              title={f}
            >
              {f}
            </div>
          ))
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {selectedFile && (
          <>
            <div className="text-xs text-gray-500 mb-2 font-mono">{selectedFile}</div>
            {loading ? (
              <div className="text-xs text-gray-500">Loading...</div>
            ) : (
              <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap">
                {fileContent}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
