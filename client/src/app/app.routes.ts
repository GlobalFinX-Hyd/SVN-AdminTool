import { Routes } from '@angular/router';
import { adminGuard, authGuard } from './core/auth';
import { Shell } from './shell';

export const routes: Routes = [
  { path: 'login', title: 'Sign in', loadComponent: () => import('./pages/login').then((m) => m.LoginPage) },
  { path: 'account/forgot', title: 'Forgot password', loadComponent: () => import('./pages/public').then((m) => m.ForgotPage) },
  { path: 'account/set-password', title: 'Set password', loadComponent: () => import('./pages/public').then((m) => m.SetPasswordPage) },
  {
    path: '',
    component: Shell,
    canActivate: [authGuard],
    children: [
      { path: 'account', title: 'My account', loadComponent: () => import('./pages/account').then((m) => m.AccountPage) },
      {
        path: '',
        canActivateChild: [adminGuard],
        children: [
          { path: '', title: 'Dashboard', loadComponent: () => import('./pages/dashboard').then((m) => m.DashboardPage) },
          { path: 'users', title: 'Users', loadComponent: () => import('./pages/users').then((m) => m.UsersPage) },
          { path: 'groups', title: 'Groups', loadComponent: () => import('./pages/groups').then((m) => m.GroupsPage) },
          { path: 'access-review', title: 'Access review', loadComponent: () => import('./pages/access-review').then((m) => m.AccessReviewPage) },
          { path: 'repositories', title: 'Repositories', loadComponent: () => import('./pages/repositories').then((m) => m.RepositoriesPage) },
          { path: 'permissions', title: 'Permissions', loadComponent: () => import('./pages/permissions').then((m) => m.PermissionsPage) },
          { path: 'locks', title: 'Locks', loadComponent: () => import('./pages/locks').then((m) => m.LocksPage) },
          { path: 'activity', title: 'Activity', loadComponent: () => import('./pages/activity').then((m) => m.ActivityPage) },
          { path: 'backups', title: 'Config backups', loadComponent: () => import('./pages/backups').then((m) => m.BackupsPage) },
          { path: 'audit', title: 'Audit log', loadComponent: () => import('./pages/audit').then((m) => m.AuditPage) },
          { path: 'system', title: 'System', loadComponent: () => import('./pages/system').then((m) => m.SystemPage) },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
