import { create } from 'zustand';

export type Role = 'Super Admin' | 'HR/QA Approver' | 'Unit Head' | 'Encoder' | 'Viewer/Auditor';

interface UserState {
  user: {
    id: string;
    name: string;
    role: Role;
    unit?: string;
    avatar?: string;
  } | null;
  login: (role: Role) => void;
  logout: () => void;
}

export const useUser = create<UserState>((set) => ({
  user: null,
  login: (role) => {
    let name = 'Admin User';
    let unit = 'University Wide';
    
    if (role === 'HR/QA Approver') {
      name = 'Maria Santos';
      unit = 'Quality Management Office';
    } else if (role === 'Unit Head') {
      name = 'Dr. Juan Dela Cruz';
      unit = 'College of Computing';
    } else if (role === 'Encoder') {
      name = 'Jane Doe';
      unit = 'College of Computing';
    } else if (role === 'Viewer/Auditor') {
      name = 'Audit Team A';
      unit = 'External Audit';
    }

    set({
      user: {
        id: '1',
        name,
        role,
        unit,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${name}`
      }
    });
  },
  logout: () => set({ user: null }),
}));
