import { useState } from "react";
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardFooter, 
  CardHeader, 
  CardTitle 
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  FileBarChart, 
  FileText, 
  Download, 
  Users, 
  Building2, 
  Briefcase, 
  CheckSquare, 
  AlertTriangle, 
  Presentation, 
  TrendingUp, 
  FileSpreadsheet,
  Printer
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ReportType {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  format: 'PDF' | 'Excel' | 'CSV' | 'View';
  category: 'Analytics' | 'Compliance' | 'Operational' | 'Export';
}

const reports: ReportType[] = [
  {
    id: 'training-hours',
    title: 'Training Hours Summary',
    description: 'Total training hours per employee accumulated over a selected period.',
    icon: FileBarChart,
    format: 'Excel',
    category: 'Analytics'
  },
  {
    id: 'participation-unit',
    title: 'Participation by Unit',
    description: 'Comparative breakdown of training participation across colleges and offices.',
    icon: Building2,
    format: 'PDF',
    category: 'Analytics'
  },
  {
    id: 'teaching-vs-non',
    title: 'Teaching vs Non-Teaching',
    description: 'Analysis of professional development distribution between academic and admin staff.',
    icon: Briefcase,
    format: 'PDF',
    category: 'Analytics'
  },
  {
    id: 'mandatory-completion',
    title: 'Mandatory Compliance',
    description: 'List of employees who have completed required university trainings.',
    icon: CheckSquare,
    format: 'Excel',
    category: 'Compliance'
  },
  {
    id: 'missing-evidence',
    title: 'Missing Evidence Report',
    description: 'Employees with attendance records lacking supporting proof or certificates.',
    icon: AlertTriangle,
    format: 'View',
    category: 'Compliance'
  },
  {
    id: 'provider-summary',
    title: 'Training Provider Summary',
    description: 'Overview of external and internal training providers and event frequency.',
    icon: Presentation,
    format: 'PDF',
    category: 'Operational'
  },
  {
    id: 'mode-trends',
    title: 'Training Mode Trends',
    description: 'Analysis of delivery modes (Webinar, F2F, Workshop) over time.',
    icon: TrendingUp,
    format: 'PDF',
    category: 'Analytics'
  },
  {
    id: 'employee-transcript',
    title: 'Employee Transcript',
    description: 'Printable individual training record for a specific employee.',
    icon: Printer,
    format: 'PDF',
    category: 'Operational'
  },
  {
    id: 'raw-export',
    title: 'Raw Data Export',
    description: 'Full dump of attendance and event tables for external analysis.',
    icon: FileSpreadsheet,
    format: 'CSV',
    category: 'Export'
  }
];

export default function Reports() {
  const { toast } = useToast();
  const [generating, setGenerating] = useState<string | null>(null);

  const handleGenerate = (report: ReportType) => {
    setGenerating(report.id);
    
    // Simulate API call
    setTimeout(() => {
      setGenerating(null);
      toast({
        title: "Report Generated",
        description: `${report.title} has been successfully generated as ${report.format}.`,
      });
    }, 1500);
  };

  const categories = Array.from(new Set(reports.map(r => r.category)));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-display font-bold">Reports & Analytics</h1>
        <p className="text-muted-foreground">Generate institutional reports and export data.</p>
      </div>

      {categories.map((category) => (
        <div key={category} className="space-y-4">
          <h2 className="text-lg font-semibold tracking-tight border-b pb-2">{category} Reports</h2>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {reports.filter(r => r.category === category).map((report) => (
              <Card key={report.id} className="flex flex-col border-border/60 hover:border-primary/50 transition-colors">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="p-2 bg-primary/10 rounded-lg text-primary mb-3">
                      <report.icon className="h-5 w-5" />
                    </div>
                    <Badge variant="outline">{report.format}</Badge>
                  </div>
                  <CardTitle className="text-base">{report.title}</CardTitle>
                  <CardDescription className="line-clamp-2">
                    {report.description}
                  </CardDescription>
                </CardHeader>
                <CardFooter className="mt-auto pt-4 border-t bg-muted/20">
                  <Button 
                    className="w-full" 
                    variant="outline" 
                    onClick={() => handleGenerate(report)}
                    disabled={generating === report.id}
                  >
                    {generating === report.id ? (
                      "Generating..."
                    ) : (
                      <>
                        <Download className="mr-2 h-4 w-4" />
                        Generate Report
                      </>
                    )}
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
