import type { CSSProperties } from 'react';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { AppSidebar } from '@/components/app-sidebar';
import { SceneView } from '@/components/scene-view';

export default function App() {
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={false} style={{ '--sidebar-width': '26rem' } as CSSProperties}>
        <AppSidebar />
        <SidebarInset className="h-svh min-h-0 overflow-hidden">
          <SceneView />
        </SidebarInset>
        <Toaster position="top-center" />
      </SidebarProvider>
    </TooltipProvider>
  );
}
