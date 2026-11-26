import { inArray, eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  employees,
  locations,
  jobs,
  stations,
  supervisorManagers,
} from '../../db/index.ts';
import {
  getEmployeeSupervisors,
  getSupervisorManagers,
  getSupervisorSubordinates,
} from '../../services/employee/employee.service.ts';

export function publicEmployee(
  e: Readonly<typeof employees.$inferSelect>,
  maskSin = true,
) {
  let formattedSin = e.sinNumber ?? null;
  if (maskSin && formattedSin) {
    formattedSin = formattedSin.replace(
      /^(\d{3})-?(\d{3})-?(\d{3})$/,
      '***-***-$3',
    );
  }

  return {
    id: e.id,
    name: e.name,
    email: e.email,
    employeeCode: e.employeeCode,
    locationId: e.locationId,
    role: e.role,
    languagePref: e.languagePref,
    status: e.status,
    dateOfBirth: e.dateOfBirth ?? null,
    fathersName: e.fathersName ?? null,
    gender: e.gender ?? null,
    address: e.address ?? null,
    phoneNumber: e.phoneNumber ?? null,
    emergencyContactName: e.emergencyContactName ?? null,
    emergencyContactRelation: e.emergencyContactRelation ?? null,
    emergencyContactPhone: e.emergencyContactPhone ?? null,
    startDate: e.startDate ?? null,
    sinNumber: formattedSin,
    hourlyRate: e.hourlyRate != null ? String(e.hourlyRate) : null,
    jobIds: e.jobIds ?? [],
    roleIds: e.jobIds ?? [],
    stationIds: e.stationIds ?? [],
    createdAt: e.createdAt.toISOString(),
    deactivatedAt: e.deactivatedAt ? e.deactivatedAt.toISOString() : null,
  };
}

export async function getJobsAndStationsMap(
  jobIds: (string | null | undefined)[],
  stationIds: (string | null | undefined)[],
) {
  const uniqueJobIds = [
    ...new Set(jobIds.filter((id): id is string => Boolean(id))),
  ];
  const uniqueStationIds = [
    ...new Set(stationIds.filter((id): id is string => Boolean(id))),
  ];

  const [jobRows, stationRows] = await Promise.all([
    uniqueJobIds.length > 0
      ? db
          .select({ id: jobs.id, name: jobs.name })
          .from(jobs)
          .where(inArray(jobs.id, uniqueJobIds))
      : Promise.resolve([]),
    uniqueStationIds.length > 0
      ? db
          .select({ id: stations.id, name: stations.name })
          .from(stations)
          .where(inArray(stations.id, uniqueStationIds))
      : Promise.resolve([]),
  ]);

  const jobMap = new Map<string, { id: string; name: string }>();
  for (const j of jobRows) {
    jobMap.set(j.id, { id: j.id, name: j.name });
  }

  const stationMap = new Map<string, { id: string; name: string }>();
  for (const s of stationRows) {
    stationMap.set(s.id, { id: s.id, name: s.name });
  }

  return { jobMap, stationMap };
}

export async function buildEmployeeResponse(
  employee: typeof employees.$inferSelect,
  locationName?: string | null,
  viewerRole?: string,
) {
  let locName = locationName;
  if (locName === undefined && employee.locationId) {
    const [loc] = await db
      .select({ name: locations.name })
      .from(locations)
      .where(eq(locations.id, employee.locationId))
      .limit(1);
    locName = loc?.name ?? null;
  }

  const [
    { jobMap, stationMap },
    supervisorsList,
    managersList,
    directSubordinates,
  ] = await Promise.all([
    getJobsAndStationsMap(employee.jobIds || [], employee.stationIds || []),
    getEmployeeSupervisors(employee.id),
    getSupervisorManagers(employee.id),
    employee.role === 'supervisor'
      ? getSupervisorSubordinates(employee.id)
      : employee.role === 'manager'
        ? db
            .select({
              id: employees.id,
              name: employees.name,
              email: employees.email,
              employeeCode: employees.employeeCode,
              locationId: employees.locationId,
              role: employees.role,
              status: employees.status,
            })
            .from(supervisorManagers)
            .innerJoin(
              employees,
              eq(employees.id, supervisorManagers.supervisorId),
            )
            .where(eq(supervisorManagers.managerId, employee.id))
        : Promise.resolve([]),
  ]);

  const resolvedJobs = (employee.jobIds || [])
    .map((id) => jobMap.get(id))
    .filter((j): j is { id: string; name: string } => Boolean(j));

  const resolvedStations = (employee.stationIds || [])
    .map((id) => stationMap.get(id))
    .filter((s): s is { id: string; name: string } => Boolean(s));

  const maskSin =
    viewerRole !== 'super_admin' &&
    viewerRole !== 'manager' &&
    viewerRole !== 'self';

  return {
    ...publicEmployee(employee, maskSin),
    locationName: locName ?? null,
    roleName: employee.role,
    jobs: resolvedJobs,
    jobIds: employee.jobIds || [],
    roleIds: employee.jobIds || [],
    stations: resolvedStations,
    stationIds: employee.stationIds || [],
    supervisors: supervisorsList,
    supervisorIds: supervisorsList.map((s) => s.id),
    managers: managersList,
    managerIds: managersList.map((m) => m.id),
    subordinates: directSubordinates,
    subordinateIds: directSubordinates.map((s) => s.id),
  };
}
