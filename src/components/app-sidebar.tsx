import { BoxesIcon, ScrollTextIcon, Settings2Icon, WaypointsIcon } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';
import { store, useStore, type Section } from '@/anatomy/store';
import { ArchitectureSection } from '@/components/sections/architecture';
import { LogsSection } from '@/components/sections/logs';
import { ConfigSection } from '@/components/sections/config';

const NAV: { key: Section; label: string; icon: typeof BoxesIcon; testid: string }[] = [
  { key: 'architecture', label: 'Architecture', icon: BoxesIcon, testid: 'nav-architecture' },
  { key: 'logs', label: 'Logs', icon: ScrollTextIcon, testid: 'nav-logs' },
  { key: 'config', label: 'Configuration', icon: Settings2Icon, testid: 'nav-config' },
];

export function AppSidebar() {
  const section = useStore((s) => s.section);
  const { setOpen } = useSidebar();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip="Anatomy of a DigitalOcean AI data pipeline">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <WaypointsIcon />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium tracking-wide">DIGITALOCEAN</span>
                <span className="truncate text-xs text-muted-foreground">AI data pipeline · anatomy</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Sections</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((n) => (
                <SidebarMenuItem key={n.key}>
                  <SidebarMenuButton
                    isActive={section === n.key}
                    tooltip={n.label}
                    data-testid={n.testid}
                    onClick={() => {
                      store.set({ section: n.key });
                      setOpen(true);
                    }}
                  >
                    <n.icon />
                    <span>{n.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <div className="flex min-h-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
          {section === 'architecture' && <ArchitectureSection />}
          {section === 'logs' && <LogsSection />}
          {section === 'config' && <ConfigSection />}
        </div>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
