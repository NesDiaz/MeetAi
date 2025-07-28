import { SidebarProvider } from "@/components/ui/sidebar";
import { DashboardNavbar } from "@/modules/dashboard/ui/components/dashboard-navbar";
import { DashboardSidebar } from "@/modules/dashboard/ui/components/dashboard-sidebar";

interface Props {
    children: React.ReactNode;
}

const Layout = ({ children }: Props) => {
    return (
        <div>
            <SidebarProvider>
                <DashboardSidebar />
                <main className="flex flex-col h-screen w-screen bg-muted">
                    <DashboardNavbar />
                    {children} 
                </main>
               
            </SidebarProvider>
            
        </div>
    );
}

export default Layout;