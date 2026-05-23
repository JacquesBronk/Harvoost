import { Badge } from '@harvoost/ui';
import { Wifi, WifiOff } from 'lucide-react';

export function SyncStatus({ connected }: { connected: boolean }) {
  return (
    <Badge tone={connected ? 'success' : 'warning'} dot className="text-[10px]">
      {connected ? (
        <>
          <Wifi className="h-3 w-3" aria-hidden="true" />
          Synced
        </>
      ) : (
        <>
          <WifiOff className="h-3 w-3" aria-hidden="true" />
          Reconnecting…
        </>
      )}
    </Badge>
  );
}
