export interface Vehicle {
  id: string;
  name: string;
  registration_number: string;
  vehicle_type: string;
  notes: string;
  enabled: boolean;
  device_id: string | null;
  device_enabled: boolean | null;
  model: string | null;
  imei: string | null;
  profile_id: string | null;
  activity: string;
  last_received_at: string | null;
}

export interface Device {
  id: string;
  imei: string;
  model: string;
  enabled: boolean;
  unassigned: boolean;
}

export interface Profile {
  id: string;
  manufacturer: string;
  model: string;
  port: number;
  diagnostic: boolean;
}

export interface DeviceLog {
  id: string;
  received_at: string;
  device_time: string | null;
  vehicle_name: string | null;
  registration_number: string | null;
  imei: string;
  packet_type: string;
  event_type: string;
  protocol: string;
  historical: boolean;
  decode_status: string;
  checksum_status: string;
  location: {
    latitude: number;
    longitude: number;
    speedKph: number | null;
    headingDegrees?: number | null;
  } | null;
  status: {
    ignition?: boolean | null;
    gpsValid?: boolean | null;
    batteryLevel?: number | null;
    batteryPercent?: number | null;
    gsmLevel?: number | null;
    externalPowerVoltage?: number | null;
    batteryVoltage?: number | null;
  } | null;
  protocol_data?: {
    trackingEnabled?: boolean | null;
    charging?: boolean | null;
    defenseActivated?: boolean | null;
    oilElectricityCutOff?: boolean | null;
    mileageRaw?: number | null;
  } | null;
}
