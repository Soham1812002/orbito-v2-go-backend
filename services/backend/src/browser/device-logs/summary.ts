import type { DeviceLog } from '../../../../../shared/contracts/console.js';

export function summarizeLog(log: DeviceLog): string {
  const position = log.location;
  const status = log.status ?? {};
  const data = log.protocol_data ?? {};
  const parts = [];

  if (position) {
    parts.push(`${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}`);
    if (position.speedKph != null) {
      parts.push(`${position.speedKph} km/h`);
    }

    if (position.headingDegrees != null) {
      parts.push(`Heading ${position.headingDegrees}°`);
    }
  } else {
    parts.push('Position not provided');
  }

  if (status.gpsValid != null) {
    parts.push(`GPS fix ${status.gpsValid ? 'valid' : 'invalid'}`);
  }

  if (status.ignition != null) {
    parts.push(`Ignition ${status.ignition ? 'ON' : 'OFF'}`);
  }

  if (status.externalPowerVoltage != null) {
    parts.push(`External voltage ${status.externalPowerVoltage.toFixed(2)} V`);
  } else if (status.batteryVoltage != null) {
    // Legacy EG02 records used batteryVoltage for external voltage.
    parts.push(`Voltage ${status.batteryVoltage.toFixed(2)} V`);
  }

  if (status.batteryLevel != null) {
    parts.push(`Battery level ${status.batteryLevel}/6`);
  }

  if (status.batteryPercent != null) {
    parts.push(`Battery ${status.batteryPercent}%`);
  }

  if (status.gsmLevel != null) {
    parts.push(`GSM level ${status.gsmLevel}`);
  }

  if (data.trackingEnabled != null) {
    parts.push(`GPS tracking flag ${data.trackingEnabled ? 'ON' : 'OFF'}`);
  }

  if (data.charging != null) {
    parts.push(`Charging ${data.charging ? 'ON' : 'OFF'}`);
  }

  if (data.defenseActivated != null) {
    parts.push(`Defense ${data.defenseActivated ? 'ON' : 'OFF'}`);
  }

  if (data.oilElectricityCutOff != null) {
    parts.push(`Fuel/electricity cutoff ${data.oilElectricityCutOff ? 'ON' : 'OFF'}`);
  }

  if (data.mileageRaw != null) {
    parts.push(`Mileage ${data.mileageRaw} (raw; unit unspecified)`);
  }

  return parts.join(' · ');
}
