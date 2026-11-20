// DSC Custom — Retenciones en Payment Entry (Nicaragua)
//
// Las tasas, cuentas, monto mínimo y base de cálculo NO están en el código: se leen de
// "DSC Retencion Config" (una por empresa), según la operación:
//   Cobro = Receive + Customer  (el cliente le retiene a la empresa  -> cuenta de activo)
//   Pago  = Pay + Supplier      (la empresa le retiene al proveedor  -> cuenta de pasivo)
//
// El cálculo lo hace el servidor (dsc_custom.api.calcular_retenciones), el mismo que valida
// los documentos al Validar. El monto mínimo se evalúa POR FACTURA.
//
// Mecánica contable en el Payment Entry:
//   Asignado a facturas = bruto (no cambia)
//   Pagado/recibido     = bruto - retenciones
//   Deducciones         = retenciones (positivas en Cobro, NEGATIVAS en Pago)
//
// Documentos (se exigen en el servidor al Validar, no al Guardar):
//   Cobro: constancia del cliente si se retiene.
//   Pago:  exoneración del proveedor si la factura alcanza el mínimo y no se retiene;
//          si se retiene, la constancia emitida es opcional.

const DSC_CONCEPTOS = ["IR", "ALMA"];
const DSC_CAMPO = { IR: "dsc_retencion_ir", ALMA: "dsc_retencion_alma" };
const DSC_DOCUMENTO = { IR: "dsc_documento_ir", ALMA: "dsc_documento_alma" };
const DSC_ENTIDAD = { IR: "DGI", ALMA: "alcaldía" };
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

function dsc_moneda(frm) {
	const company = frm.doc.company && frappe.get_doc(":Company", frm.doc.company);
	return (company && company.default_currency) || frm.doc.paid_from_account_currency;
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
	if (!operacion) {
		frm.set_df_property(DSC_SECCION, "hidden", 1);
		return;
	}

	// Documento ya validado: se muestra la sección solo si tiene algo que consultar.
	if (frm.doc.docstatus !== 0) {
		const tieneDatos = DSC_CONCEPTOS.some((c) => frm.doc[DSC_CAMPO[c]] || frm.doc[DSC_DOCUMENTO[c]]);
		frm.set_df_property(DSC_SECCION, "hidden", tieneDatos ? 0 : 1);
		return;
	}

	const cfg = await dsc_cargar_reglas(frm);
	const moneda = dsc_moneda(frm);
	let alguna = false;
	for (const concepto of DSC_CONCEPTOS) {
		const regla = cfg && cfg.reglas[concepto];
		const campo = DSC_CAMPO[concepto];
		const documento = DSC_DOCUMENTO[concepto];
		frm.set_df_property(campo, "hidden", regla ? 0 : 1);
		frm.set_df_property(documento, "hidden", regla ? 0 : 1);
		if (!regla) continue;
		alguna = true;

		let etiqueta = __("Retener {0} {1}%", [concepto, regla.tasa]);
		if (flt(regla.monto_minimo) > 0) {
			etiqueta += " " + __("(facturas desde {0})", [format_currency(regla.monto_minimo, moneda)]);
		}
		frm.set_df_property(campo, "label", etiqueta);

		if (operacion === "Cobro") {
			frm.set_df_property(documento, "label", __("Constancia de retención {0} ({1})", [concepto, DSC_ENTIDAD[concepto]]));
			frm.set_df_property(
				documento,
				"description",
				__("PDF o imagen que entrega el cliente. Obligatoria al Validar si se marca la retención.")
			);
		} else {
			frm.set_df_property(documento, "label", __("Exoneración o constancia {0} del proveedor", [concepto]));
			frm.set_df_property(
				documento,
				"description",
				__(
					"PDF o imagen. Obligatoria al Validar si alguna factura alcanza el mínimo y NO se retiene (exoneración). Si se retiene, es opcional (constancia emitida)."
				)
			);
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
		await dsc_desmarcar(frm, DSC_CONCEPTOS);
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

	const marcados = DSC_CONCEPTOS.filter((c) => frm.doc[DSC_CAMPO[c]] && cfg.reglas[c]);

	// Sin ninguna retención marcada: se deja el pago como estaba (bruto, sin nuestras deducciones).
	if (!marcados.length) {
		await dsc_reemplazar_deducciones(frm, []);
		if (brutoTotal) dsc_fijar_montos(frm, filas, bruto, flt(brutoTotal, 2));
		frm._dsc_bruto = null;
		return;
	}

	if (!brutoTotal) {
		frappe.msgprint(__("Primero indique la factura en la tabla de Referencias para poder calcular la retención."));
		await dsc_desmarcar(frm, marcados);
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
		method: "dsc_custom.api.calcular_retenciones",
		args: { company: frm.doc.company, operacion, referencias: JSON.stringify(payload) },
	});
	const conceptos = r.message.conceptos || {};
	const moneda = dsc_moneda(frm);
	const avisos = [];

	if (r.message.ignoradas && r.message.ignoradas.length) {
		avisos.push(
			__("Estas referencias no son facturas de venta/compra y no entran en la base: {0}", [
				r.message.ignoradas.join(", "),
			])
		);
	}

	const signo = operacion === "Pago" ? -1 : 1;
	const nuevas = [];
	const sinMinimo = [];
	let totalRetenido = 0;
	marcados.forEach((concepto) => {
		const res = conceptos[concepto];
		const fuera = ((res && res.facturas) || []).filter((f) => !f.aplica);
		if (fuera.length) {
			avisos.push(
				__("{0}: no alcanzan el mínimo de {1} y no se retienen: {2}", [
					concepto,
					format_currency(res.monto_minimo, moneda),
					fuera.map((f) => `${f.factura} (${format_currency(f.valor, moneda)})`).join(", "),
				])
			);
		}
		if (!res || !flt(res.monto)) {
			sinMinimo.push(concepto);
			return;
		}
		totalRetenido += flt(res.monto);
		nuevas.push({
			account: res.cuenta,
			cost_center: cfg.cost_center,
			amount: signo * flt(res.monto),
			description: `${DSC_MARCA}Retención ${concepto} ${res.tasa}%`,
			_concepto: concepto,
			_monto: flt(res.monto),
			_base: flt(res.base),
		});
	});

	// Conceptos marcados sin ninguna factura que alcance el mínimo: no hay retención que aplicar.
	if (sinMinimo.length) {
		await dsc_desmarcar(frm, sinMinimo);
		avisos.push(__("Se desmarcó {0}: ninguna factura alcanza el monto mínimo.", [sinMinimo.join(", ")]));
	}

	await dsc_reemplazar_deducciones(frm, nuevas);
	dsc_fijar_montos(frm, filas, bruto, flt(brutoTotal - totalRetenido, 2));

	if (avisos.length) {
		frappe.msgprint({ title: __("Retenciones"), indicator: "blue", message: avisos.join("<br><br>") });
	}

	if (nuevas.length) {
		frappe.show_alert(
			{
				message: __("{0}<hr>Neto a {1}: <b>{2}</b>", [
					nuevas
						.map(
							(n) =>
								`${n._concepto}: <b>${format_currency(n._monto, moneda)}</b> ` +
								__("sobre {0}", [format_currency(n._base, moneda)])
						)
						.join("<br>"),
					operacion === "Cobro" ? __("recibir") : __("pagar"),
					format_currency(brutoTotal - totalRetenido, moneda),
				]),
				indicator: "blue",
			},
			7
		);
	}

	// Aviso si el pago no cuadra. Se revisan las dos cosas: ERPNext puede dejar la diferencia
	// en 0 y aun así tener monto sin asignar.
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

async function dsc_desmarcar(frm, conceptos) {
	for (const concepto of conceptos) {
		if (frm.doc[DSC_CAMPO[concepto]]) await frm.set_value(DSC_CAMPO[concepto], 0);
	}
}
