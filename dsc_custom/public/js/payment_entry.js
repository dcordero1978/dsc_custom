// DSC Custom — Retenciones en Payment Entry (Nicaragua)
//
// Las tasas y las cuentas NO están en el código: se leen de "DSC Retencion Config"
// (una por empresa), según la operación:
//   Cobro = Receive + Customer  (el cliente le retiene a la empresa  -> cuenta de activo)
//   Pago  = Pay + Supplier      (la empresa le retiene al proveedor  -> cuenta de pasivo)
//
// Base de cálculo: subtotal SIN IVA y con el descuento aplicado (net total) de cada factura
// referenciada, en proporción a lo asignado en el pago.
//
// Mecánica contable en el Payment Entry:
//   Asignado a facturas = bruto (no cambia)
//   Pagado/recibido     = bruto - retenciones
//   Deducciones         = retenciones (positivas en Cobro, NEGATIVAS en Pago)

const DSC_CONCEPTOS = ["IR", "ALMA"];
const DSC_CAMPO = { IR: "dsc_retencion_ir", ALMA: "dsc_retencion_alma" };
const DSC_SECCION = "dsc_retencion_section";
const DSC_MARCA = "[DSC] "; // prefijo en la descripción de las deducciones que genera este script

frappe.ui.form.on("Payment Entry", {
	refresh(frm) {
		dsc_preparar(frm);
	},
	payment_type(frm) {
		dsc_preparar(frm);
	},
	party_type(frm) {
		dsc_preparar(frm);
	},
	company(frm) {
		dsc_preparar(frm);
	},
	dsc_retencion_ir(frm) {
		dsc_aplicar(frm);
	},
	dsc_retencion_alma(frm) {
		dsc_aplicar(frm);
	},
});

function dsc_operacion(frm) {
	if (frm.doc.payment_type === "Receive" && frm.doc.party_type === "Customer") return "Cobro";
	if (frm.doc.payment_type === "Pay" && frm.doc.party_type === "Supplier") return "Pago";
	return null;
}

async function dsc_cargar_reglas(frm) {
	const operacion = dsc_operacion(frm);
	if (!operacion || !frm.doc.company) return null;

	const clave = `${frm.doc.company}|${operacion}`;
	if (frm._dsc_cfg && frm._dsc_cfg.clave === clave) return frm._dsc_cfg;

	const r = await frappe.call({
		method: "dsc_custom.api.get_reglas_retencion",
		args: { company: frm.doc.company, operacion },
	});
	frm._dsc_cfg = { clave, reglas: r.message.reglas || {}, cost_center: r.message.cost_center };
	return frm._dsc_cfg;
}

async function dsc_preparar(frm) {
	// Si los custom fields todavía no están instalados, no hacemos nada.
	if (!frm.fields_dict[DSC_SECCION]) return;

	const operacion = dsc_operacion(frm);
	if (!operacion || frm.doc.docstatus !== 0) {
		frm.set_df_property(DSC_SECCION, "hidden", 1);
		return;
	}

	const cfg = await dsc_cargar_reglas(frm);
	let alguna = false;
	for (const concepto of DSC_CONCEPTOS) {
		const regla = cfg && cfg.reglas[concepto];
		const campo = DSC_CAMPO[concepto];
		frm.set_df_property(campo, "hidden", regla ? 0 : 1);
		if (regla) {
			frm.set_df_property(campo, "label", __("Retener {0} {1}%", [concepto, regla.tasa]));
			alguna = true;
		}
	}
	frm.set_df_property(DSC_SECCION, "hidden", alguna ? 0 : 1);

	if (!alguna) {
		frm.set_intro(
			__("No hay reglas de retención activas de tipo {0} para la empresa {1}. Configúrelas en DSC Retencion Config.", [
				operacion,
				frm.doc.company,
			]),
			"orange"
		);
		frm._dsc_intro = true;
	} else if (frm._dsc_intro) {
		frm.set_intro("");
		frm._dsc_intro = false;
	}

	if (alguna) {
		frm.add_custom_button(__("Recalcular retenciones"), () => dsc_aplicar(frm));
	}
}

async function dsc_aplicar(frm) {
	if (frm._dsc_ocupado) return; // evita que nuestros propios cambios disparen otro cálculo
	const operacion = dsc_operacion(frm);
	if (!operacion || frm.doc.docstatus !== 0) return;

	frm._dsc_ocupado = true;
	try {
		await dsc_calcular(frm, operacion);
	} finally {
		frm._dsc_ocupado = false;
	}
}

async function dsc_calcular(frm, operacion) {
	const cfg = await dsc_cargar_reglas(frm);
	if (!cfg) return;

	// Solo se soporta pago en moneda de la empresa (tasas de cambio = 1).
	if (flt(frm.doc.source_exchange_rate) !== 1 || flt(frm.doc.target_exchange_rate) !== 1) {
		frappe.msgprint(__("Las retenciones automáticas solo funcionan cuando el pago es en la moneda de la empresa."));
		await dsc_desmarcar(frm);
		return;
	}

	const filas = frm.doc.references || [];

	// Bruto asignado por fila: se guarda la primera vez para no depender de lo que ERPNext
	// reacomode después en "Asignado" al cambiar el monto pagado.
	if (!frm._dsc_bruto) frm._dsc_bruto = {};
	filas.forEach((f) => {
		if (!(f.name in frm._dsc_bruto)) frm._dsc_bruto[f.name] = flt(f.allocated_amount);
	});
	const bruto = (f) => flt(frm._dsc_bruto[f.name]);
	const brutoTotal = filas.reduce((s, f) => s + bruto(f), 0);

	const activos = DSC_CONCEPTOS.filter((c) => frm.doc[DSC_CAMPO[c]] && cfg.reglas[c]);

	// Sin ninguna retención marcada: se deja el pago como estaba (bruto, sin nuestras deducciones).
	if (!activos.length) {
		await dsc_reemplazar_deducciones(frm, []);
		if (brutoTotal) dsc_fijar_montos(frm, filas, bruto, flt(brutoTotal, 2));
		frm._dsc_bruto = null;
		return;
	}

	if (!brutoTotal) {
		frappe.msgprint(__("Primero indique la factura en la tabla de Referencias para poder calcular la retención."));
		await dsc_desmarcar(frm);
		return;
	}

	const payload = filas
		.filter((f) => bruto(f) > 0)
		.map((f) => ({
			reference_doctype: f.reference_doctype,
			reference_name: f.reference_name,
			allocated_amount: bruto(f),
		}));
	const r = await frappe.call({
		method: "dsc_custom.api.get_base_retencion",
		args: { referencias: JSON.stringify(payload) },
	});
	const base = flt(r.message.base);
	if (r.message.ignoradas && r.message.ignoradas.length) {
		frappe.msgprint(
			__("Estas referencias no son facturas de venta/compra y no entran en la base: {0}", [
				r.message.ignoradas.join(", "),
			])
		);
	}

	const signo = operacion === "Pago" ? -1 : 1;
	const nuevas = [];
	let totalRetenido = 0;
	activos.forEach((concepto) => {
		const regla = cfg.reglas[concepto];
		const monto = flt((base * regla.tasa) / 100, 2);
		totalRetenido += monto;
		nuevas.push({
			account: regla.cuenta,
			cost_center: cfg.cost_center,
			amount: signo * monto,
			description: `${DSC_MARCA}Retención ${concepto} ${regla.tasa}%`,
			_concepto: concepto,
			_monto: monto,
		});
	});

	await dsc_reemplazar_deducciones(frm, nuevas);
	dsc_fijar_montos(frm, filas, bruto, flt(brutoTotal - totalRetenido, 2));

	const moneda = frm.doc.paid_from_account_currency;
	frappe.show_alert(
		{
			message: __("Base: {0}<br>{1}<hr>Neto a {2}: <b>{3}</b>", [
				format_currency(base, moneda),
				nuevas
					.map((n) => `${n._concepto}: <b>${format_currency(n._monto, moneda)}</b>`)
					.join("<br>"),
				operacion === "Cobro" ? __("recibir") : __("pagar"),
				format_currency(brutoTotal - totalRetenido, moneda),
			]),
			indicator: "blue",
		},
		7
	);

	// Aviso si el pago no cuadra. Se revisan las dos cosas: ERPNext puede dejar la diferencia
	// en 0 y aun así tener monto sin asignar (así se escapó el doble descuento).
	setTimeout(() => {
		const dif = flt(frm.doc.difference_amount);
		const sinAsignar = flt(frm.doc.unallocated_amount);
		if (Math.abs(dif) > 0.005 || Math.abs(sinAsignar) > 0.005) {
			frappe.msgprint({
				title: __("Revise el pago"),
				indicator: "orange",
				message: __(
					"Diferencia de monto: {0}. Monto sin asignar: {1}. Se esperaba 0 en ambos; verifique Asignado, Monto pagado y Deducciones.",
					[format_currency(dif, moneda), format_currency(sinAsignar, moneda)]
				),
			});
		}
	}, 500);
}

// Reemplaza solo las deducciones generadas por este script; las demás se conservan.
async function dsc_reemplazar_deducciones(frm, nuevas) {
	const otras = (frm.doc.deductions || [])
		.filter((d) => !(d.description || "").startsWith(DSC_MARCA))
		.map((d) => ({
			account: d.account,
			cost_center: d.cost_center,
			amount: d.amount,
			description: d.description,
		}));
	frm.clear_table("deductions");
	otras.forEach((d) => frm.add_child("deductions", d));
	nuevas.forEach((n) =>
		frm.add_child("deductions", {
			account: n.account,
			cost_center: n.cost_center,
			amount: n.amount,
			description: n.description,
		})
	);
	frm.refresh_field("deductions");
}

// Fija lo asignado (bruto) y lo pagado/recibido (neto) SIN disparar los eventos de ERPNext.
// Cambiar paid_amount con frm.set_value dispara allocate_amount_to_references en el servidor
// (asíncrono), que hace "asignado = pagado - deducciones": las retenciones quedarían
// descontadas dos veces y "Monto sin asignar" sería el doble de la retención.
// Solo se usa con tasas de cambio = 1 (se valida antes), por eso base = monto.
function dsc_fijar_montos(frm, filas, bruto, neto) {
	filas.forEach((f) => {
		f.allocated_amount = bruto(f);
	});
	frm.doc.paid_amount = neto;
	frm.doc.base_paid_amount = neto;
	frm.doc.received_amount = neto;
	frm.doc.base_received_amount = neto;

	["paid_amount", "base_paid_amount", "received_amount", "base_received_amount", "references"].forEach((campo) =>
		frm.refresh_field(campo)
	);
	frm.dirty();

	// Recalcula total asignado, monto sin asignar y diferencia con la lógica de ERPNext.
	frm.events.set_total_allocated_amount(frm);
}

async function dsc_desmarcar(frm) {
	for (const concepto of DSC_CONCEPTOS) {
		if (frm.doc[DSC_CAMPO[concepto]]) await frm.set_value(DSC_CAMPO[concepto], 0);
	}
}
