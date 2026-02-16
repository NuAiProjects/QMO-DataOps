import { useState } from "react";
import { mockTrainings } from "@/lib/mockData";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { 
  Card, 
  CardContent, 
  CardFooter, 
  CardHeader, 
  CardTitle,
  CardDescription
} from "@/components/ui/card";
import { 
  Calendar as CalendarIcon, 
  MapPin, 
  Users, 
  Clock, 
  MoreVertical,
  Plus
} from "lucide-react";
import { useUser } from "@/hooks/use-user";

export default function Trainings() {
  const { user } = useUser();
  const [filter, setFilter] = useState("All");

  const canCreate = user?.role !== 'Viewer/Auditor';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold">Training Events</h1>
          <p className="text-muted-foreground">Browse and manage upcoming seminars and workshops.</p>
        </div>
        {canCreate && (
          <Button className="shadow-md">
            <Plus className="mr-2 h-4 w-4" />
            Create Event
          </Button>
        )}
      </div>

      <div className="flex items-center gap-4 overflow-x-auto pb-2">
        {["All", "Upcoming", "Completed", "Drafts"].map((f) => (
          <Button
            key={f}
            variant={filter === f ? "default" : "outline"}
            onClick={() => setFilter(f)}
            className="rounded-full"
            size="sm"
          >
            {f}
          </Button>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {mockTrainings.map((event) => (
          <Card key={event.id} className="group hover:shadow-lg transition-all border-border/60">
            <CardHeader>
              <div className="flex justify-between items-start">
                <Badge variant="outline" className="mb-2 w-fit bg-primary/5 text-primary border-primary/20">
                  {event.type}
                </Badge>
                <Button variant="ghost" size="icon" className="-mr-2 -mt-2 h-8 w-8 text-muted-foreground">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </div>
              <CardTitle className="line-clamp-2 leading-tight h-12">
                {event.title}
              </CardTitle>
              <CardDescription className="flex items-center mt-1">
                <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                {new Date(event.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm text-muted-foreground">
                <div className="flex items-center">
                  <Clock className="mr-2 h-3.5 w-3.5" />
                  {event.hours} Hours Credit
                </div>
                <div className="flex items-center">
                  <Users className="mr-2 h-3.5 w-3.5" />
                  {event.organizer}
                </div>
              </div>
            </CardContent>
            <CardFooter className="pt-2 border-t bg-muted/20">
              <div className="flex w-full items-center justify-between">
                <Badge variant={
                  event.status === 'Upcoming' ? 'default' : 
                  event.status === 'Completed' ? 'secondary' : 'outline'
                }>
                  {event.status}
                </Badge>
                <Button variant="link" size="sm" className="h-auto p-0">
                  View Details
                </Button>
              </div>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}
