import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle 
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCircle2, XCircle, Clock, FileText } from "lucide-react";

export default function Approvals() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold">Approvals</h1>
        <p className="text-muted-foreground">Review and approve training records and attendance submissions.</p>
      </div>

      <Tabs defaultValue="pending" className="space-y-4">
        <TabsList>
          <TabsTrigger value="pending">Pending Review</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        
        <TabsContent value="pending" className="space-y-4">
          {[1, 2].map((i) => (
            <Card key={i} className="border-border/60">
              <CardHeader className="pb-3">
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle className="text-lg">Attendance Report: AI Integration Workshop</CardTitle>
                    <CardDescription>Submitted by College of Computing • 2 hours ago</CardDescription>
                  </div>
                  <Badge variant="outline" className="bg-amber-50 text-amber-600 border-amber-200">
                    Needs Review
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex gap-6 text-sm mb-4">
                  <div className="flex items-center text-muted-foreground">
                    <Clock className="mr-2 h-4 w-4" />
                    Pending for 2 hours
                  </div>
                  <div className="flex items-center text-muted-foreground">
                    <FileText className="mr-2 h-4 w-4" />
                    15 Attendees
                  </div>
                </div>
                
                <div className="flex justify-end gap-2">
                  <Button variant="outline" className="text-destructive hover:text-destructive hover:bg-destructive/10">
                    <XCircle className="mr-2 h-4 w-4" />
                    Return for Revision
                  </Button>
                  <Button className="bg-emerald-600 hover:bg-emerald-700">
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Approve
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
        
        <TabsContent value="history">
          <div className="text-center py-10 text-muted-foreground">
            No approval history yet.
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
