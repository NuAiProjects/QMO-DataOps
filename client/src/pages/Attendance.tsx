import { useState } from "react";
import { mockEmployees, mockTrainings } from "@/lib/mockData";
import { Button } from "@/components/ui/button";
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle 
} from "@/components/ui/card";
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from "@/components/ui/select";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Upload, Save, CheckCircle, Search } from "lucide-react";
import { useUser } from "@/hooks/use-user";
import { Input } from "@/components/ui/input";

export default function Attendance() {
  const { user } = useUser();
  const [selectedEvent, setSelectedEvent] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState("");

  const event = mockTrainings.find(e => e.id === selectedEvent);
  
  // Mock filtered employees for selection
  const filteredEmployees = mockEmployees.filter(emp => 
    emp.lastName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    emp.firstName.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold">Attendance Recording</h1>
        <p className="text-muted-foreground">Record participation for training events.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-1 h-fit border-border/60">
          <CardHeader>
            <CardTitle>Select Event</CardTitle>
            <CardDescription>Choose a training to record attendance for</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select value={selectedEvent} onValueChange={setSelectedEvent}>
              <SelectTrigger>
                <SelectValue placeholder="Select event..." />
              </SelectTrigger>
              <SelectContent>
                {mockTrainings.filter(t => t.status !== 'Draft').map((training) => (
                  <SelectItem key={training.id} value={training.id}>
                    {training.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {event && (
              <div className="rounded-md bg-muted/30 p-4 text-sm space-y-2 border">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Date:</span>
                  <span className="font-medium">{event.date}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Type:</span>
                  <span className="font-medium">{event.type}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Hours:</span>
                  <span className="font-medium">{event.hours}</span>
                </div>
                <div className="pt-2">
                  <Badge variant="outline" className="w-full justify-center">
                    {event.status}
                  </Badge>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2 border-border/60">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Attendance Sheet</CardTitle>
              <CardDescription>
                {event ? `Recording for: ${event.title}` : "Select an event to start"}
              </CardDescription>
            </div>
            {event && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm">
                  <Upload className="mr-2 h-4 w-4" />
                  Bulk Upload CSV
                </Button>
                <Button size="sm">
                  <Save className="mr-2 h-4 w-4" />
                  Save Changes
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {!event ? (
              <div className="flex flex-col items-center justify-center h-[300px] text-muted-foreground border-2 border-dashed rounded-lg">
                <CheckCircle className="h-10 w-10 mb-4 opacity-20" />
                <p>Please select an event to manage attendance</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input 
                    placeholder="Search employee to add..." 
                    className="pl-9"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>

                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[50px]">
                          <Checkbox />
                        </TableHead>
                        <TableHead>Employee</TableHead>
                        <TableHead>Department</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Proof</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {/* Simulating some existing records */}
                      <TableRow>
                        <TableCell><Checkbox defaultChecked /></TableCell>
                        <TableCell>
                          <div className="font-medium">Juan Dela Cruz</div>
                          <div className="text-xs text-muted-foreground">NU-2023-001</div>
                        </TableCell>
                        <TableCell>College of Computing</TableCell>
                        <TableCell>
                          <Badge variant="default" className="bg-emerald-500 hover:bg-emerald-600">Present</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" className="h-8 text-blue-500">View</Button>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell><Checkbox /></TableCell>
                        <TableCell>
                          <div className="font-medium">Maria Santos</div>
                          <div className="text-xs text-muted-foreground">NU-2023-002</div>
                        </TableCell>
                        <TableCell>HR Department</TableCell>
                        <TableCell>
                          <Badge variant="secondary">Pending</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" className="h-8">Upload</Button>
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
